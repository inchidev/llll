/**
 * The start of a Git `git-receive-pack` request: its ref update commands, read before anything is forwarded.
 * The egress layer allows a push only when it updates exactly the approved branch to exactly the approved
 * commit; the pack after the commands is Git's own, and the receiving server checks it against those hashes.
 */
export type ReceiveCommand = { old: string; new: string; ref: string }
export type ReceivePack = { commands: ReceiveCommand[]; capabilities: string[]; end: number }

/** Commands of a real push fit well within this; a longer start is refused rather than buffered. */
export const RECEIVE_PACK_COMMANDS_BYTES = 65536
const ZERO = '0'.repeat(40)
const SHA = /^[a-f0-9]{40}$/u
const FLUSH = '0000'
/** What a push from the box's own Git may ask for. Push options and signed pushes are refused. */
const CAPABILITIES = new Set(['report-status', 'report-status-v2', 'side-band', 'side-band-64k', 'quiet', 'atomic', 'ofs-delta', 'object-format=sha1'])
const PREFIXED = ['agent=', 'session-id=']

export class GitPktLineError extends Error {}

/**
 * Reads the command list at the start of a receive-pack request body. Returns null while it is incomplete,
 * and throws on anything that is not a well-formed command list.
 */
export function parseReceivePack(bytes: Uint8Array): ReceivePack | null {
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const commands: ReceiveCommand[] = []
  let capabilities: string[] = [], offset = 0
  for (;;) {
    if (bytes.length < offset + 4) return null
    const header = decoder.decode(bytes.subarray(offset, offset + 4))
    if (!/^[0-9a-f]{4}$/u.test(header)) throw new GitPktLineError('Invalid pkt-line length')
    if (header === FLUSH) return { commands, capabilities, end: offset + 4 }
    const length = Number.parseInt(header, 16)
    if (length < 5) throw new GitPktLineError('Unexpected special packet')
    if (bytes.length < offset + length) return null
    let line: string
    try { line = decoder.decode(bytes.subarray(offset + 4, offset + length)) } catch { throw new GitPktLineError('Invalid command encoding') }
    offset += length
    if (line.endsWith('\n')) line = line.slice(0, -1)
    if (!commands.length) {
      const nul = line.indexOf('\0')
      if (nul >= 0) { capabilities = line.slice(nul + 1).split(' ').filter(Boolean); line = line.slice(0, nul) }
      if (line.startsWith('push-cert')) throw new GitPktLineError('Signed pushes are not accepted')
    } else if (line.includes('\0')) throw new GitPktLineError('Capabilities only follow the first command')
    const [old, next, ref, ...rest] = line.split(' ')
    if (!old || !next || !ref || rest.length) throw new GitPktLineError('Invalid ref update command')
    commands.push({ old, new: next, ref })
  }
}

/** Why a push other than `<old> <sha> <ref>` for the one approved update is refused, or null when it is that push. */
export function receivePackRefusal(pack: ReceivePack, expected: { ref: string; sha: string }) {
  if (pack.commands.length !== 1) return pack.commands.length ? 'Only one ref update is allowed' : 'No ref update'
  const [command] = pack.commands as [ReceiveCommand]
  if (!SHA.test(command.old) || !SHA.test(command.new)) return 'Invalid object name'
  if (command.ref !== expected.ref) return 'Only the Task’s own branch may be pushed'
  if (command.new === ZERO) return 'A branch cannot be deleted'
  if (command.new !== expected.sha) return 'Only the approved commit may be pushed'
  const unknown = pack.capabilities.find(capability => !CAPABILITIES.has(capability) && !PREFIXED.some(prefix => capability.startsWith(prefix)))
  if (unknown) return `Push capability ${unknown.split('=')[0]} is not accepted`
  return null
}

/** Git's probe before a large push: an empty command list, to check authentication. */
export const receivePackProbe = (bytes: Uint8Array) => bytes.length === 4 && new TextDecoder().decode(bytes) === FLUSH

/**
 * Reads a receive-pack request's commands from its body and decides: a refusal, or a body that replays the
 * bytes already read and then the rest, unchanged, to forward.
 */
export async function inspectReceivePack(body: ReadableStream<Uint8Array> | null, expected: { ref: string; sha: string }):
  Promise<{ refusal: string } | { body: ReadableStream<Uint8Array> }> {
  if (!body) return { refusal: 'No ref update' }
  const reader = body.getReader()
  let read = new Uint8Array(0), done = false, parsed: ReceivePack | null = null
  try {
    while (!parsed) {
      const next = await reader.read()
      if (next.value?.length) {
        const joined = new Uint8Array(read.length + next.value.length)
        joined.set(read); joined.set(next.value, read.length)
        read = joined
      }
      done = next.done
      parsed = parseReceivePack(read)
      if (!parsed && (done || read.length > RECEIVE_PACK_COMMANDS_BYTES)) throw new GitPktLineError('Incomplete ref update commands')
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined)
    return { refusal: error instanceof GitPktLineError ? error.message : 'Unreadable push' }
  }
  // A probe is an empty command list and nothing after it.
  if (!parsed.commands.length && !done && read.length === parsed.end) {
    const next = await reader.read().catch(() => ({ done: false, value: new Uint8Array(1) }))
    if (!next.done || next.value?.length) { await reader.cancel().catch(() => undefined); return { refusal: 'No ref update' } }
    done = true
  }
  if (!(parsed.commands.length === 0 && done && receivePackProbe(read))) {
    const refusal = receivePackRefusal(parsed, expected)
    if (refusal) { await reader.cancel().catch(() => undefined); return { refusal } }
  }
  const prefix = read
  let sent = false
  return { body: new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!sent) { sent = true; controller.enqueue(prefix); if (done) controller.close(); return }
      const next = await reader.read()
      if (next.done) controller.close(); else controller.enqueue(next.value)
    },
    async cancel(reason) { await reader.cancel(reason) },
  }) }
}
