import { createServer } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { openPi } from './pi.mjs'
import { runtimeInput } from './protocol.mjs'

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
  if (request.method === 'GET' && url.pathname === '/session') {
    if (active) { response.writeHead(409).end(); return }
    try {
      const sessionDirectory = join(directory, 'session')
      const file = (await readFile(join(sessionDirectory, 'session-path'), 'utf8')).trim()
      if (!file.startsWith(sessionDirectory + '/')) throw new Error('Invalid session path')
      const transcript = await readFile(file, 'utf8')
      if (Buffer.byteLength(transcript) > 2_000_000) throw new Error('Transcript too large')
      json(response, 200, { transcript })
    } catch { json(response, 200, { transcript: null }) }
    return
  }
  if (request.method !== 'POST' || url.pathname !== '/run') { response.writeHead(404).end(); return }
  try {
    let bytes = 0
    const chunks = []
    for await (const chunk of request) { bytes += chunk.length; if (bytes > 2_128_000) { response.writeHead(413).end(); return }; chunks.push(chunk) }
    const input = runtimeInput.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')))
    if (identity) { json(response, identity === input.runId ? 202 : 409, { status: active ? 'running' : 'finished' }); return }
    identity = input.runId
    active = new AbortController()
    const controller = active
    await writeFile(identityFile, identity, { mode: 0o600 })
    const sessionDirectory = join(directory, 'session')
    if (input.transcript) {
      await mkdir(sessionDirectory, { recursive: true })
      const restored = join(sessionDirectory, 'restored.jsonl')
      await writeFile(restored, input.transcript, { mode: 0o600 })
      await writeFile(join(sessionDirectory, 'session-path'), restored, { mode: 0o600 })
    }
    json(response, 202, { status: 'running' })
    const timeout = setTimeout(() => controller.abort(), input.timeoutMs)
    const execute = async () => {
      let result
      try {
        // Fail with a useful transport diagnosis before entering the SDK's model loop.
        // This authenticated GET cannot invoke a model or a Server tool.
        let probe
        try {
          probe = await fetch(input.toolEndpoint, { headers: { Authorization: `Bearer ${input.modelGateway.token}` }, signal: AbortSignal.timeout(10000) })
        } catch (error) {
          const code = typeof error.cause?.code === 'string' ? error.cause.code.slice(0, 80) : error.name
          throw new Error(`Gateway connection failed (${code})`, { cause: error })
        }
        if (probe.status !== 405) throw new Error(`Gateway rejected readiness check (${probe.status})`)
        const pi = await openPi(input, { directory: sessionDirectory, emit, signal: controller.signal,
          callTool: async (call, signal) => {
            const tool = await fetch(input.toolEndpoint, { method: 'POST', signal,
              headers: { Authorization: `Bearer ${input.modelGateway.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ ...call, runId: input.runId }) })
            if (!tool.ok) throw new Error(`Tool rejected (${tool.status})`)
            return tool.json()
          },
        })
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
