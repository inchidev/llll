import { createServer } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { openPi } from './pi.mjs'
import { prepareFiles, changedFiles } from './files.mjs'
import { runtimeInput } from './protocol.mjs'
import { callGatewayTool, probeGateway } from './gateway.mjs'
import { restoreSession, savedTranscript } from './session.mjs'

const token = process.env.LLLL_RUN_TOKEN
if (!token || token.length < 32) throw new Error('LLLL_RUN_TOKEN must contain at least 32 characters')
const expected = Buffer.from(`Bearer ${token}`)
const directory = process.env.LLLL_AGENT_DATA || '/data'
await mkdir(directory, { recursive: true, mode: 0o700 })
const identityFile = join(directory, 'identity')
const eventFile = join(directory, 'events.jsonl')
const resultFile = join(directory, 'result.json')
let identity = existsSync(identityFile) ? readFileSync(identityFile, 'utf8') : undefined
let active
let eventBytes = existsSync(eventFile) ? Buffer.byteLength(readFileSync(eventFile)) : 0
const emit = event => {
  const line = JSON.stringify(event) + '\n'
  if (eventBytes + Buffer.byteLength(line) > 2_000_000 && event.type !== 'error') { active?.abort(); return }
  eventBytes += Buffer.byteLength(line)
  appendFileSync(eventFile, line, { mode: 0o600 })
}
const json = (response, code, value) => response.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(value))
const server = createServer(async (request, response) => {
  const supplied = Buffer.from(request.headers.authorization || '')
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { response.writeHead(401).end(); return }
  const url = new URL(request.url, 'http://runtime')
  if (request.method === 'GET' && url.pathname === '/health') { json(response, 200, { status: 'ready' }); return }
  if (request.method === 'DELETE' && url.pathname === '/run') { active?.abort(); json(response, 202, { status: 'cancelling' }); return }
  if (request.method === 'GET' && url.pathname === '/run') {
    const after = Number(url.searchParams.get('after') || 0)
    if (!Number.isSafeInteger(after) || after < 0) { response.writeHead(400).end(); return }
    const all = existsSync(eventFile) ? readFileSync(eventFile, 'utf8').trim().split('\n').filter(Boolean) : []
    const events = all.slice(after, after + 100).map(line => JSON.parse(line))
    json(response, 200, { status: active ? 'running' : existsSync(resultFile) ? 'finished' : identity ? 'interrupted' : 'idle', events, nextCursor: after + events.length, result: existsSync(resultFile) ? JSON.parse(readFileSync(resultFile, 'utf8')) : null }); return
  }
  if (request.method === 'GET' && url.pathname === '/files') {
    if (active) { response.writeHead(409).end(); return }
    try { json(response, 200, await changedFiles(join(directory, 'session', 'work'))) }
    catch { json(response, 422, { error: 'Working files exceed archive limits or are unavailable' }) }
    return
  }
  if (request.method === 'GET' && url.pathname === '/session') {
    if (active) { response.writeHead(409).end(); return }
    json(response, 200, { transcript: await savedTranscript(join(directory, 'session')) })
    return
  }
  if (request.method !== 'POST' || url.pathname !== '/run') { response.writeHead(404).end(); return }
  try {
    let bytes = 0
    const chunks = []
    for await (const chunk of request) { bytes += chunk.length; if (bytes > 2_128_000) { response.writeHead(413).end(); return }; chunks.push(chunk) }
    const input = runtimeInput.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')))
    // This executor is not a box: a turn with native tools belongs on the Task's box only.
    if (input.box) { response.writeHead(400).end('Invalid run request'); return }
    if (identity) { json(response, identity === input.runId ? 202 : 409, { status: active ? 'running' : 'finished' }); return }
    identity = input.runId
    active = new AbortController()
    const controller = active
    await writeFile(identityFile, identity, { mode: 0o600 })
    const sessionDirectory = join(directory, 'session')
    if (input.transcript) await restoreSession(sessionDirectory, input.transcript)
    json(response, 202, { status: 'running' })
    const timeout = setTimeout(() => controller.abort(), input.timeoutMs)
    const execute = async () => {
      let result
      try {
        await probeGateway(input)
        await prepareFiles(input, join(sessionDirectory, 'work'), controller.signal)
        const pi = await openPi(input, { directory: sessionDirectory, emit, signal: controller.signal, callTool: (call, signal) => callGatewayTool(input, call, signal) })
        result = { type: 'result', ...(await pi.run(input.prompt)) }
      } catch (error) { result = { type: 'error', message: error instanceof Error ? error.message : 'Run failed' } }
      finally { clearTimeout(timeout) }
      emit(result)
      await writeFile(resultFile, JSON.stringify(result), { mode: 0o600 })
      active = undefined
    }
    void execute().catch(() => { active = undefined })
  } catch { if (!response.headersSent) response.writeHead(400).end('Invalid run request') }
})
server.listen(Number(process.env.PORT || 8080), '0.0.0.0')
