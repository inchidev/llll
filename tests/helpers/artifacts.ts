import { inflateSync } from 'node:zlib'
import { vi } from 'vitest'
import { parsePktLines, pktLine } from '../../server/utils/git-pack'

/**
 * The Server's Artifacts namespace as a test sees it: repositories with refs and commits, tokens with a scope,
 * and the Git smart-HTTP endpoints a push and an advertisement reach. A push is applied as a repository would:
 * the token must be a live write token of that repository, the ref must still be at `old`, and the pack's
 * objects are unpacked, so commits the Server made can be read back through the binding afterwards.
 */
export type FakeCommit = { hash: string; treeHash: string; parents: string[]; message: string; author: { name: string; email: string }; committer: { name: string; email: string }; authoredAt: number; committedAt: number }
export type FakeRepo = { id: string; name: string; remote: string; defaultBranch: string; refs: Map<string, string>; commits: Map<string, FakeCommit>; objects: Map<string, { type: string; body: Buffer }>
  tokens: Map<string, { plaintext: string; scope: 'read' | 'write'; revoked: boolean }>; deleted: boolean }
export type Push = { repo: string; token: string; commands: string[]; objects: Array<{ type: string; id: string }> }

const TYPES = ['', 'commit', 'tree', 'blob', 'tag'] as const
const sha1 = async (type: string, body: Uint8Array) => {
  const header = new TextEncoder().encode(`${type} ${body.byteLength}\0`), joined = new Uint8Array(header.byteLength + body.byteLength)
  joined.set(header); joined.set(body, header.byteLength)
  return [...new Uint8Array(await crypto.subtle.digest('SHA-1', joined))].map(byte => byte.toString(16).padStart(2, '0')).join('')
}
function parseCommit(hash: string, body: string): FakeCommit {
  const [headers, ...rest] = body.split('\n\n')
  const line = (name: string) => headers!.split('\n').filter(entry => entry.startsWith(name + ' ')).map(entry => entry.slice(name.length + 1))
  const who = (value: string | undefined) => { const match = /^(.*) <([^>]*)> (\d+)/u.exec(value ?? '') ; return { name: match?.[1] ?? '', email: match?.[2] ?? '', at: Number(match?.[3] ?? 0) } }
  const author = who(line('author')[0]), committer = who(line('committer')[0])
  return { hash, treeHash: line('tree')[0] ?? '', parents: line('parent'), message: rest.join('\n\n').replace(/\n$/u, ''), author: { name: author.name, email: author.email }, committer: { name: committer.name, email: committer.email }, authoredAt: author.at, committedAt: committer.at }
}
/** A Git tree's entries, as the binding's readTree gives them. */
function parseTree(body: Buffer) {
  const entries: Array<{ name: string; mode: string; hash: string; type: 'tree' | 'blob' | 'symlink' | 'gitlink' | 'exec' }> = []
  for (let at = 0; at < body.length;) {
    const space = body.indexOf(0x20, at), nul = body.indexOf(0, space)
    const mode = body.subarray(at, space).toString()
    entries.push({ name: body.subarray(space + 1, nul).toString(), mode, hash: body.subarray(nul + 1, nul + 21).toString('hex'),
      type: mode === '40000' ? 'tree' : mode === '160000' ? 'gitlink' : mode === '120000' ? 'symlink' : mode === '100755' ? 'exec' : 'blob' })
    at = nul + 21
  }
  return entries
}

/** The whole objects of a pack, inflated one after another. */
async function unpack(bytes: Buffer) {
  const count = bytes.readUInt32BE(8), objects: Array<{ type: string; id: string; body: Buffer }> = []
  let offset = 12
  for (let index = 0; index < count; index++) {
    let byte = bytes[offset++]!, size = byte & 15, shift = 4
    const type = (byte >> 4) & 7
    while (byte & 0x80) { byte = bytes[offset++]!; size += (byte & 0x7f) * 2 ** shift; shift += 7 }
    const inflated = inflateSync(bytes.subarray(offset), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } }
    if (inflated.buffer.byteLength !== size) throw new Error('Pack object size mismatch')
    offset += inflated.engine.bytesWritten
    objects.push({ type: TYPES[type]!, id: await sha1(TYPES[type]!, inflated.buffer), body: inflated.buffer })
  }
  return objects
}

export function fakeArtifacts(account = 'acc', namespace = 'l4') {
  const repos = new Map<string, FakeRepo>(), pushes: Push[] = []
  let ids = 0
  const error = (code: string) => Object.assign(new Error(code), { code })
  const repo = (name: string) => { const found = repos.get(name); if (!found || found.deleted) throw error('NOT_FOUND'); return found }
  const remote = (name: string) => `https://${account}.artifacts.cloudflare.net/git/${namespace}/${name}.git`
  const token = (target: FakeRepo, scope: 'read' | 'write') => {
    const id = `tok-${++ids}`, plaintext = `art_v1_${scope}-${id}-${target.name}`
    target.tokens.set(id, { plaintext, scope, revoked: false })
    return { id, plaintext, scope, expiresAt: new Date(Date.now() + 60000).toISOString() }
  }
  /** A commit the repository already holds, written by a test as a box's push would leave it. */
  const seed = (name: string, commit: Omit<FakeCommit, 'author' | 'committer' | 'authoredAt' | 'committedAt'> & Partial<FakeCommit>, refs: Record<string, string> = {}) => {
    const target = repo(name)
    target.commits.set(commit.hash, { author: { name: 'Agent', email: 'agent@example.test' }, committer: { name: 'Agent', email: 'agent@example.test' }, authoredAt: 1, committedAt: 1, ...commit })
    for (const [ref, sha] of Object.entries(refs)) target.refs.set(ref, sha)
  }
  const binding = {
    create: vi.fn(async (name: string, options?: { description?: string; setDefaultBranch?: string }) => {
      if (repos.has(name) && !repos.get(name)!.deleted) throw error('ALREADY_EXISTS')
      const created: FakeRepo = { id: `repo-${++ids}`, name, remote: remote(name), defaultBranch: options?.setDefaultBranch ?? 'main', refs: new Map(), commits: new Map(), objects: new Map(), tokens: new Map(), deleted: false }
      repos.set(name, created)
      return { id: created.id, name, description: options?.description ?? null, defaultBranch: created.defaultBranch, remote: created.remote, token: token(created, 'write').plaintext }
    }),
    get: vi.fn(async (name: string) => {
      const target = repo(name)
      return {
        info: async () => ({ id: target.id, name, description: null, defaultBranch: target.defaultBranch, remote: target.remote, createdAt: '2026-11-08', updatedAt: '2026-11-08', lastPushAt: null }),
        createToken: async (scope: 'read' | 'write' = 'write') => token(target, scope),
        listTokens: async () => ({ total: target.tokens.size, tokens: [] }),
        revokeToken: async (idOrPlaintext: string) => { for (const [id, entry] of target.tokens) if (id === idOrPlaintext || entry.plaintext === idOrPlaintext) { entry.revoked = true; return true } return false },
        log: async ({ ref, limit = 50 }: { ref?: string; limit?: number } = {}) => {
          let hash = target.refs.get(ref!) ?? target.refs.get(`refs/heads/${ref}`) ?? target.refs.get(`refs/tags/${ref}`) ?? (target.commits.has(ref!) ? ref! : undefined)
          const chain: FakeCommit[] = []
          while (hash && chain.length < limit) { const entry = target.commits.get(hash); if (!entry) break; chain.push(entry); hash = entry.parents[0] }
          return chain
        },
        readCommit: async (hash: string) => target.commits.get(hash) ?? null,
        // Trees and blobs come from what was pushed: the README the Server commits, or a test's own objects.
        readTree: async (hash: string) => { const found = target.objects.get(hash); return found?.type === 'tree' ? parseTree(found.body) : null },
        readBlob: async (hash: string) => { const found = target.objects.get(hash); return found?.type === 'blob' ? new Blob([found.body]) : null },
        readFile: async ({ ref, path }: { ref: string; path: string }) => {
          const hash = target.refs.get(ref) ?? target.refs.get(`refs/heads/${ref}`) ?? target.refs.get(`refs/tags/${ref}`) ?? (target.commits.has(ref) ? ref : undefined)
          let tree = hash ? target.commits.get(hash)?.treeHash : undefined
          const parts = path.split('/').filter(Boolean)
          for (const [index, part] of parts.entries()) {
            const entries = tree ? (target.objects.get(tree)?.type === 'tree' ? parseTree(target.objects.get(tree)!.body) : []) : []
            const entry = entries.find(item => item.name === part)
            if (!entry) return null
            if (index === parts.length - 1) { const blob = target.objects.get(entry.hash); return blob?.type === 'blob' ? new Blob([blob.body]) : null }
            tree = entry.hash
          }
          return null
        },
        fork: async () => { throw error('INTERNAL_ERROR') },
        [Symbol.dispose]: vi.fn(),
      }
    }),
    delete: vi.fn(async (name: string) => { const target = repos.get(name); if (!target) return false; target.deleted = true; return true }),
    list: vi.fn(async () => ({ repos: [], total: 0 })),
    import: vi.fn(async () => { throw error('INTERNAL_ERROR') }),
  }
  const liveTokens = (target: FakeRepo) => [...target.tokens.values()].filter(entry => !entry.revoked)
  /** The Git smart-HTTP side of the namespace, for `fetch`. Anything else answers 404. */
  const network = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const request = input instanceof Request ? input : new Request(String(input), init)
    const url = new URL(request.url), match = /^\/git\/([^/]+)\/([^/]+)\.git(\/.*)$/u.exec(url.pathname)
    if (url.hostname !== `${account}.artifacts.cloudflare.net` || !match || match[1] !== namespace) return new Response('not here', { status: 404 })
    const target = repos.get(match[2]!)
    if (!target || target.deleted) return new Response('no repository', { status: 404 })
    const presented = request.headers.get('authorization')?.replace(/^Bearer /u, '') ?? ''
    const live = liveTokens(target).find(entry => entry.plaintext === presented)
    if (!live) return new Response('bad token', { status: 401 })
    const service = url.searchParams.get('service')
    if (request.method === 'GET' && match[3] === '/info/refs' && (service === 'git-upload-pack' || service === 'git-receive-pack')) {
      if (service === 'git-receive-pack' && live.scope !== 'write') return new Response('read token', { status: 403 })
      const lines = [...target.refs].map(([ref, sha], index) => pktLine(`${sha} ${ref}${index ? '' : '\0report-status delete-refs'}\n`))
      if (!lines.length) lines.push(pktLine(`${'0'.repeat(40)} capabilities^{}\0report-status\n`))
      return new Response(pktLine(`# service=${service}\n`) + '0000' + lines.join('') + '0000', { headers: { 'Content-Type': `application/x-${service}-advertisement` } })
    }
    if (request.method === 'POST' && match[3] === '/git-upload-pack') return new Response('PACK', { headers: { 'Content-Type': 'application/x-git-upload-pack-result' } })
    if (request.method === 'POST' && match[3] === '/git-receive-pack') {
      if (live.scope !== 'write') return new Response('read token', { status: 403 })
      const body = Buffer.from(await request.arrayBuffer())
      const packAt = body.indexOf('PACK'), commands = parsePktLines(body.subarray(0, packAt < 0 ? body.byteLength : packAt))
      const objects = packAt >= 0 ? await unpack(body.subarray(packAt)) : []
      pushes.push({ repo: target.name, token: presented, commands, objects: objects.map(({ type, id }) => ({ type, id })) })
      const report: string[] = ['unpack ok']
      for (const object of objects) {
        target.objects.set(object.id, { type: object.type, body: object.body })
        if (object.type === 'commit') target.commits.set(object.id, parseCommit(object.id, object.body.toString()))
      }
      for (const command of commands) {
        const [old, next, ref] = command.split('\0')[0]!.split(' ') as [string, string, string]
        const current = target.refs.get(ref) ?? '0'.repeat(40)
        if (current !== old) { report.push(`ng ${ref} fetch first`); continue }
        if (next !== '0'.repeat(40) && !target.commits.has(next) && !target.objects.has(next)) { report.push(`ng ${ref} missing necessary objects`); continue }
        if (next === '0'.repeat(40)) target.refs.delete(ref); else target.refs.set(ref, next)
        report.push(`ok ${ref}`)
      }
      return new Response(report.map(line => pktLine(line + '\n')).join('') + '0000', { headers: { 'Content-Type': 'application/x-git-receive-pack-result' } })
    }
    return new Response('not a git service', { status: 404 })
  })
  return { binding, network, repos, pushes, seed, remote, liveTokens }
}
export type FakeArtifacts = ReturnType<typeof fakeArtifacts>
