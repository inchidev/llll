/**
 * Git objects and a smart-HTTP push, made by the Server itself (ADR 0013). Artifacts has no API that writes a
 * commit, a ref or a tag, only `git push`, so this is the trusted path for what L4 writes to a Project's
 * repository on its own: the merge commit of an approved Task, a release tag and a new repository's first
 * commit. No box is involved and no write token leaves the Server. The pack holds whole objects, never deltas;
 * everything it refers to already exists in the repository.
 */
export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag'
export type GitObject = { type: GitObjectType; body: Uint8Array }
export type GitIdentity = { name: string; email: string }
export type RefCommand = { old: string; new: string; ref: string }
export type PushResult = { ok: true } | { ok: false; reason: string }

const encoder = new TextEncoder(), decoder = new TextDecoder()
const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 }
export const ZERO_SHA = '0'.repeat(40)
const SHA = /^[a-f0-9]{40}$/u
const FLUSH = '0000'

export const hex = (bytes: ArrayBuffer | Uint8Array) => [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('')
const raw = (sha: string) => Uint8Array.from(sha.match(/../gu)!.map(pair => Number.parseInt(pair, 16)))
export const sha1 = async (bytes: Uint8Array) => hex(await crypto.subtle.digest('SHA-1', bytes as Uint8Array<ArrayBuffer>))
export function concat(parts: Uint8Array[]) {
  const joined = new Uint8Array(parts.reduce((size, part) => size + part.byteLength, 0))
  let offset = 0
  for (const part of parts) { joined.set(part, offset); offset += part.byteLength }
  return joined
}

/** The id Git gives an object: the hash of its type, size and body. */
export const objectId = (object: GitObject) => sha1(concat([encoder.encode(`${object.type} ${object.body.byteLength}\0`), object.body]))
export const blob = (text: string | Uint8Array): GitObject => ({ type: 'blob', body: typeof text === 'string' ? encoder.encode(text) : text })

export type TreeEntry = { mode: '100644' | '100755' | '040000' | '120000'; name: string; id: string }
/** A tree's entries in Git's order: by name, a directory compared as if its name ended in `/`. Modes are written without a leading zero. */
export function tree(entries: TreeEntry[]): GitObject {
  const key = (entry: TreeEntry) => entry.mode === '040000' ? entry.name + '/' : entry.name
  const sorted = [...entries].sort((left, right) => key(left) < key(right) ? -1 : key(left) > key(right) ? 1 : 0)
  for (const entry of sorted) if (!entry.name || entry.name.includes('/') || entry.name.includes('\0') || ['.', '..', '.git'].includes(entry.name) || !SHA.test(entry.id)) throw new Error('Invalid tree entry')
  return { type: 'tree', body: concat(sorted.flatMap(entry => [encoder.encode(`${entry.mode.replace(/^0+/u, '')} ${entry.name}\0`), raw(entry.id)])) }
}

/** A name and address as a commit header holds them: no angle brackets or line breaks, and never empty. */
export function identity(value: GitIdentity): GitIdentity {
  const clean = (text: string) => text.replace(/[<>\p{Cc}]+/gu, ' ').trim()
  return { name: clean(value.name) || 'L4', email: clean(value.email).replace(/\s+/gu, '') || 'noreply@llll.gg' }
}
const stamp = (who: GitIdentity, at: Date) => `${identity(who).name} <${identity(who).email}> ${Math.floor(at.getTime() / 1000)} +0000`
const message = (text: string) => text.replace(/\r\n?/gu, '\n').replace(/\n*$/u, '') + '\n'

export function commit(input: { tree: string; parents: string[]; author: GitIdentity; committer?: GitIdentity; message: string; at?: Date }): GitObject {
  if (!SHA.test(input.tree) || input.parents.some(parent => !SHA.test(parent))) throw new Error('Invalid commit reference')
  const at = input.at ?? new Date()
  const lines = [`tree ${input.tree}`, ...input.parents.map(parent => `parent ${parent}`), `author ${stamp(input.author, at)}`, `committer ${stamp(input.committer ?? input.author, at)}`]
  return { type: 'commit', body: encoder.encode(lines.join('\n') + '\n\n' + message(input.message)) }
}
/** An annotated tag of a commit. */
export function tag(input: { object: string; name: string; tagger: GitIdentity; message: string; at?: Date }): GitObject {
  if (!SHA.test(input.object) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u.test(input.name) || input.name.includes('..')) throw new Error('Invalid tag')
  return { type: 'tag', body: encoder.encode(`object ${input.object}\ntype commit\ntag ${input.name}\ntagger ${stamp(input.tagger, input.at ?? new Date())}\n\n${message(input.message)}`) }
}

async function deflate(bytes: Uint8Array) {
  const stream = new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new CompressionStream('deflate'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}
/** An object's pack entry header: its type in the first byte's bits 4–6 and its size in little-endian 7-bit groups. */
function entryHeader(type: GitObjectType, size: number) {
  const bytes: number[] = []
  let byte = (TYPE_CODE[type] << 4) | (size & 0x0f), rest = Math.floor(size / 16)
  while (rest > 0) { bytes.push(byte | 0x80); byte = rest & 0x7f; rest = Math.floor(rest / 128) }
  bytes.push(byte)
  return Uint8Array.from(bytes)
}
const uint32 = (value: number) => Uint8Array.from([(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff])
/** A pack of whole objects, version 2, with its checksum; empty when there is nothing new to send. */
export async function pack(objects: GitObject[]) {
  const entries: Uint8Array[] = []
  for (const object of objects) entries.push(entryHeader(object.type, object.body.byteLength), await deflate(object.body))
  const content = concat([encoder.encode('PACK'), uint32(2), uint32(objects.length), ...entries])
  return concat([content, raw(await sha1(content))])
}

export const pktLine = (text: string) => (encoder.encode(text).byteLength + 4).toString(16).padStart(4, '0') + text
/** The pkt-lines of a response, without their lengths, up to and across flush packets. */
export function parsePktLines(bytes: Uint8Array) {
  const lines: string[] = []
  for (let offset = 0; offset + 4 <= bytes.byteLength;) {
    const length = Number.parseInt(decoder.decode(bytes.subarray(offset, offset + 4)), 16)
    if (!Number.isFinite(length)) throw new Error('Invalid pkt-line')
    if (length < 4) { offset += 4; continue }
    lines.push(decoder.decode(bytes.subarray(offset + 4, offset + length)).replace(/\n$/u, ''))
    offset += length
  }
  return lines
}

const gitHeaders = (token: string, extra: Record<string, string> = {}) => ({ Authorization: `Bearer ${token}`, 'User-Agent': 'L4-git', ...extra })
async function body(response: Response, limit: number) {
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength > limit) throw new Error('Git answer too large')
  return bytes
}

/**
 * The refs a repository advertises for a service, read with a repository token: exactly what a push's `old`
 * values must name. An empty repository advertises none.
 */
export async function advertisedRefs(remote: string, token: string, service: 'git-upload-pack' | 'git-receive-pack', transport: typeof fetch = fetch) {
  const response = await transport(`${remote}/info/refs?service=${service}`, { headers: gitHeaders(token), redirect: 'manual', signal: AbortSignal.timeout(30000) })
  if (!response.ok) { await response.body?.cancel(); throw new Error(`The repository did not advertise its refs (HTTP ${response.status})`) }
  const refs = new Map<string, string>()
  for (const line of parsePktLines(await body(response, 4_000_000))) {
    if (line.startsWith('#')) continue
    const [sha, name] = line.split('\0')[0]!.split(' ')
    if (sha && name && SHA.test(sha) && name !== 'capabilities^{}' && !name.endsWith('^{}')) refs.set(name, sha)
  }
  return refs
}

/**
 * One push: the ref updates and the objects they need, as Git sends them, with `report-status` so the answer
 * says what the repository did. The repository applies an update only while the ref is still at `old`, so a
 * branch that moved meanwhile refuses it instead of losing a commit.
 */
export async function pushRefs(remote: string, token: string, commands: RefCommand[], objects: GitObject[], transport: typeof fetch = fetch): Promise<PushResult> {
  if (!commands.length) throw new Error('Nothing to push')
  for (const command of commands) if (!SHA.test(command.old) || !SHA.test(command.new) || !/^refs\/(?:heads|tags)\/[^\s~^:?*[\\]+$/u.test(command.ref) || command.ref.includes('..')) throw new Error('Invalid ref update')
  const lines = commands.map((command, index) => pktLine(`${command.old} ${command.new} ${command.ref}${index ? '' : '\0report-status agent=l4'}\n`))
  const request = concat([encoder.encode(lines.join('') + FLUSH), await pack(objects)])
  const response = await transport(`${remote}/git-receive-pack`, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(120000),
    headers: gitHeaders(token, { 'Content-Type': 'application/x-git-receive-pack-request', Accept: 'application/x-git-receive-pack-result' }), body: request as Uint8Array<ArrayBuffer> })
  if (!response.ok) {
    const text = decoder.decode(await body(response, 16000).catch(() => new Uint8Array())).replace(/\p{Cc}+/gu, ' ').trim().slice(0, 300)
    return { ok: false, reason: `HTTP ${response.status}${text ? `: ${text}` : ''}` }
  }
  const report = parsePktLines(await body(response, 1_000_000)).map(line => line.startsWith('\u0001') ? line.slice(1) : line)
  const unpack = report.find(line => line.startsWith('unpack '))
  if (unpack && unpack !== 'unpack ok') return { ok: false, reason: unpack.slice('unpack '.length).slice(0, 300) }
  const refused = report.find(line => line.startsWith('ng '))
  if (refused) return { ok: false, reason: refused.replace(/^ng \S+ ?/u, '').slice(0, 300) || 'The repository refused the update' }
  const confirmed = commands.every(command => report.includes(`ok ${command.ref}`))
  return confirmed ? { ok: true } : { ok: false, reason: 'The repository did not confirm the update' }
}
