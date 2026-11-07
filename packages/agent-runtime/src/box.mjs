import { createServer } from 'node:net'
import { lstat, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { openPi } from './pi.mjs'
import { runtimeInput } from './protocol.mjs'
import { callGatewayTool, gatewayUrl, probeGateway } from './gateway.mjs'
import { createPushBatcher } from './push.mjs'
import { restoreSession, savedTranscript } from './session.mjs'

/** Turn events a box may send in one turn, as the container executor allowed. */
const TURN_EVENT_BYTES = 2_000_000, KEPT_TURNS = 100
/** One request on the control socket: a submission with its transcript. */
export const CONTROL_BYTES = 2_600_000

const clip = (event) => event.type === 'result' ? { ...event, text: event.text.slice(0, 100000), steps: Math.min(event.steps, 1000) }
  : event.type === 'error' ? { ...event, message: event.message.slice(0, 2000) } : event

/**
 * The Agent's box: one Task's checkout on its persistent disk, and Pi with its own tools working in it.
 * The trusted daemon hands it one turn at a time over a local socket; the box reports the turn itself
 * through the Server's gateway with the Run's capability, the only secret it holds. A turn that began
 * before the box stopped is never started again: its result says so instead.
 */
export function boxRuntime({ root = '/work', fetcher = fetch, batch = {} } = {}) {
  root = resolve(root)
  const repository = join(root, 'repo'), state = join(root, '.l4'), turns = join(state, 'turns'), session = join(state, 'pi')
  let active = null

  async function checkout() {
    try { return (await lstat(join(repository, '.git'))).isDirectory() } catch { return false }
  }

  async function remember(runId) {
    await mkdir(turns, { recursive: true, mode: 0o700 })
    try { await writeFile(join(turns, runId), '', { flag: 'wx', mode: 0o600 }) } catch (error) { if (error.code === 'EEXIST') return false; throw error }
    const kept = (await readdir(turns, { withFileTypes: true })).filter(entry => entry.isFile())
    if (kept.length > KEPT_TURNS) {
      const dated = await Promise.all(kept.map(async entry => ({ name: entry.name, at: (await lstat(join(turns, entry.name))).mtimeMs })))
      for (const old of dated.sort((a, b) => a.at - b.at).slice(0, kept.length - KEPT_TURNS)) await rm(join(turns, old.name), { force: true })
    }
    return true
  }

  async function run(input, fresh, turn) {
    const { controller } = turn
    let pi = null, bytes = 0
    const batcher = createPushBatcher({ url: gatewayUrl(input, 'events'), token: input.modelGateway.token, fetcher, ...batch,
      steered: (input.steering ?? []).map(message => message.messageId),
      onCancel: () => turn.cancel(), onSteer: message => pi?.steer(message.content) })
    const emit = event => {
      const size = JSON.stringify(event).length
      if (bytes + size > TURN_EVENT_BYTES) { controller.abort(); return }
      bytes += size
      batcher.push(event)
    }
    const timeout = setTimeout(() => controller.abort(), input.timeoutMs)
    let result
    try {
      if (!fresh) throw new Error('The box stopped during this turn. Ask again to continue')
      await probeGateway(input, fetcher)
      await restoreSession(session, input.transcript)
      pi = await openPi(input, { directory: session, cwd: repository, emit, signal: controller.signal,
        callTool: (call, signal) => callGatewayTool(input, call, signal, { fetcher }) })
      for (const message of input.steering ?? []) pi.steer(message.content)
      result = { type: 'result', ...(await pi.run(input.prompt)) }
    } catch (error) {
      result = { type: 'error', message: turn.cancelled ? 'Run cancelled' : error instanceof Error ? error.message : 'Run failed' }
    } finally { clearTimeout(timeout) }
    // The session goes first: once the result lands, the Run finishes and takes nothing more.
    const transcript = fresh ? await savedTranscript(session) : null
    if (transcript) {
      try {
        const saved = await fetcher(gatewayUrl(input, 'session'), { method: 'PUT', redirect: 'error', signal: AbortSignal.timeout(30000),
          headers: { Authorization: `Bearer ${input.modelGateway.token}`, 'Content-Type': 'application/jsonl' }, body: transcript })
        await saved.body?.cancel()
      } catch { /* The Run archives without this session; the result still ends the turn. */ }
    }
    return { ok: await batcher.finish(clip(result)), result: result.type }
  }

  return {
    async health() {
      return { status: active ? 'running' : 'ready', ...(active ? { runId: active.runId } : {}), checkout: await checkout() }
    },
    /** Starts a turn; `done` settles when the Run has its result. The same turn asked again joins it. */
    async turn(submission) {
      const parsed = runtimeInput.safeParse(submission)
      if (!parsed.success || !parsed.data.box) return { accepted: false, error: 'Not a turn for a box' }
      const input = parsed.data
      if (active) return active.runId === input.runId ? { accepted: true, done: active.done } : { accepted: false, error: 'The box is busy with another turn' }
      if (!await checkout()) return { accepted: false, error: 'The box has no checkout' }
      const turn = { runId: input.runId, controller: new AbortController(), cancelled: false,
        cancel() { turn.cancelled = true; turn.controller.abort() } }
      active = turn
      turn.done = (async () => run(input, await remember(input.runId), turn))().finally(() => { active = null })
      return { accepted: true, done: turn.done }
    },
    cancel(runId) {
      if (!active || (runId && active.runId !== runId)) return { ok: false }
      active.cancel()
      return { ok: true }
    },
    get active() { return active?.runId ?? null },
  }
}

/**
 * Serves the box's control socket: one JSON request per connection, answered in JSON lines. control.mjs
 * half-closes once it has sent its request, so the socket stays open for the answer until it is written.
 */
export function serveControl(box) {
  const server = createServer({ allowHalfOpen: true }, connection => {
    let buffer = ''
    connection.setEncoding('utf8')
    const write = value => { if (!connection.destroyed) connection.write(JSON.stringify(value) + '\n') }
    connection.on('error', () => {})
    // A request that ended without its line gets no answer.
    connection.on('end', () => { if (buffer !== null) connection.end() })
    connection.on('data', async chunk => {
      if (buffer === null) return
      buffer += chunk
      if (buffer.length > CONTROL_BYTES) { buffer = null; write({ error: 'Request too large' }); connection.end(); return }
      const end = buffer.indexOf('\n')
      if (end < 0) return
      const line = buffer.slice(0, end)
      buffer = null
      try {
        const request = JSON.parse(line)
        if (request?.op === 'health') write(await box.health())
        else if (request?.op === 'cancel') write(box.cancel(typeof request.runId === 'string' ? request.runId : undefined))
        else if (request?.op === 'turn') {
          const started = await box.turn(request.submission)
          if (!started.accepted) write({ accepted: false, error: started.error })
          else { write({ accepted: true }); write({ done: true, ...(await started.done) }) }
        } else write({ error: 'Unknown operation' })
      } catch { write({ error: 'Invalid request' }) }
      connection.end()
    })
  })
  return server
}

if (process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  const socket = process.env.LLLL_BOX_SOCKET || '/run/l4/control.sock'
  await rm(socket, { force: true })
  const server = serveControl(boxRuntime({ root: process.env.LLLL_BOX_ROOT || '/work' }))
  server.listen(socket)
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { server.close(); process.exit(0) })
}
