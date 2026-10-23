import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { build } from 'esbuild'
import { mkdtemp, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import './build.mjs'
const root = await mkdtemp(resolve(import.meta.dirname, '../../../.deployment/opencode-case-'))
const gatewayFile = resolve(import.meta.dirname, '../../../.deployment/opencode-acceptance/gateway.mjs')
await build({ entryPoints: [resolve(import.meta.dirname, 'gateway.ts')], outfile: gatewayFile, bundle: true, format: 'esm', platform: 'node', packages: 'external', loader: { '.sql': 'text' }, logLevel: 'warning' })
const { fixture } = await import(pathToFileURL(gatewayFile).href)
const gateway = fixture(root + '/gateway.sqlite')
let held = false, hold = false, holdModel = false, modelRequests = 0
const toolRequests = []
const server = createServer(async (request, response) => {
  try {
    let body = ''; for await (const part of request) body += part
    if (request.url === '/tools') {
      const payload = JSON.parse(body); toolRequests.push(payload)
      const result = await gateway.tools(new Request('http://l4/tools', { method: 'POST', headers: request.headers, body }))
      if (hold && payload.name === 'create_task' && result.ok) { held = true; return }
      response.writeHead(result.status, { 'Content-Type': 'application/json' }).end(await result.text()); return
    }
    const payload = JSON.parse(body); modelRequests++
    if (holdModel) return
    const serialized = JSON.stringify(payload.messages)
    const lastTool = payload.messages.filter(message => message.role === 'tool').at(-1)
    const interrupted = lastTool && JSON.stringify(lastTool).includes('Tool execution interrupted')
    const used = Boolean(lastTool) && !interrupted
    const write = serialized.includes('WRITE_PROOF')
    const delta = used ? { role: 'assistant', content: 'Evidence preserved' } : { role: 'assistant', tool_calls: [{ index: 0, id: interrupted ? 'retry-probe-call' : 'stable-probe-call', type: 'function', function: { name: write ? 'create_task' : 'list_tasks', arguments: write ? JSON.stringify({ boardId: 'board-allowed', title: 'Crash recovery proof' }) : '{}' } }] }
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    for (const choice of [{ delta, finish_reason: null }, { delta: {}, finish_reason: used ? 'stop' : 'tool_calls' }]) response.write('data: ' + JSON.stringify({ id: 'probe', object: 'chat.completion.chunk', created: 1, model: 'glm-5.3-flash-free', choices: [{ index: 0, ...choice }] }) + '\n\n')
    response.end('data: [DONE]\n\n')
  } catch (error) { response.writeHead(500).end(error.name) }
})
await new Promise(ready => server.listen(0, '127.0.0.1', ready))
const upstream = `http://127.0.0.1:${server.address().port}`
let child, origin
async function launch() {
  child = spawn(process.execPath, [resolve(import.meta.dirname, 'host.mjs')], { detached: true, env: { ...process.env, L4_PROBE_DIR: root, L4_PROBE_UPSTREAM: upstream }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  child.stdout.on('data', chunk => process.stdout.write(chunk)); child.stderr.on('data', chunk => process.stderr.write(chunk))
  origin = await new Promise((ready, reject) => { child.once('message', message => ready(message.url)); child.once('error', reject); child.once('exit', code => reject(new Error(`Host exited ${code}`))) })
}
async function kill() { if (!child) return; const stopped = new Promise(ready => child.once('exit', ready)); process.kill(-child.pid, 'SIGKILL'); await stopped; child = undefined }
async function request(id, path, body) {
  let response
  for (let attempt=0;attempt<3;attempt++) { try { response = await fetch(new URL(`/${id}${path}`, origin), { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: 'Bearer local-acceptance-only', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000) }); break } catch(error) { if(body !== undefined || attempt === 2)throw error; await new Promise(ready=>setTimeout(ready,100)); } }
  assert.equal(response.status, 200, await response.clone().text())
  return response.json()
}
async function until(check, message) { for (let i = 0; i < 80; i++) { const value = await check(); if (value) return value; await new Promise(ready => setTimeout(ready, 250)) } throw new Error(message) }
async function finished(id) { let last; try {return await until(async () => { last = await request(id, '/state'); return last.result ? last : null }, 'Session did not finish')} catch(e) {console.log('INCOMPLETE',JSON.stringify(last)); throw e;} }
try {
  await launch()
  if (!process.env.L4_PROBE_SKIP_FREE) {
  const real = randomUUID(), run = await gateway.run()
  const info = await request(real, '/info'); assert.equal(info.version, '2.1.4')
  await request(real, '/start', { ...run, prompt: 'Call list_tasks once. Report the name of the board it returns. Do not use any other tools.' })
  const answer = await finished(real)
  assert.equal(answer.result.type, 'session.execution.succeeded', JSON.stringify(answer.result))
  assert.match(answer.text, /Allowed board/iu)
  assert.equal(gateway.db.prepare("SELECT count(*) as count FROM agent_run_tools WHERE run_id=? AND name='list_tasks' AND status='completed'").get(run.runId).count, 1)
  assert.ok(!JSON.stringify(answer.context).includes('board-private'))
  console.log('PASS: free GLM in workerd DO calls the real L4 tool gateway and sees only its authorized board')
  }
  const denied = randomUUID(), denyRun = await gateway.run()
  await request(denied, '/start', { ...denyRun, fixture: true, prompt: 'WRITE_PROOF' })
  await finished(denied)
  assert.equal(gateway.db.prepare('SELECT count(*) as count FROM tasks').get().count, 0)
  assert.equal(gateway.db.prepare("SELECT status FROM agent_run_tools WHERE run_id=?").get(denyRun.runId).status, 'failed')
  console.log('PASS: actual L4 gateway denies a write from an OpenCode tool under a read-only role')
  const crash = randomUUID(), crashRun = await gateway.run(true)
  hold = true
  await request(crash, '/start', { ...crashRun, fixture: true, prompt: 'WRITE_PROOF' })
  await until(() => held, 'No committed write reached the crash boundary')
  assert.equal(gateway.db.prepare('SELECT count(*) as count FROM tasks').get().count, 1)
  await kill(); hold = false; await launch()
  const recovered = await finished(crash)
  assert.equal(recovered.result.type, 'session.execution.succeeded', JSON.stringify(recovered.result))
  assert.equal(gateway.db.prepare('SELECT count(*) as count FROM tasks').get().count, 2, 'Expected a retry under a new call ID to demonstrate the native recovery boundary')
  assert.ok(JSON.stringify(recovered.context).includes('Tool execution interrupted'))
  console.log('OBSERVED: native recovery marks the committed in-flight tool aborted; a new model call ID creates a duplicate task')
  const budget = randomUUID(), budgetRun = await gateway.run()
  const beforeBudget = modelRequests
  await request(budget, '/start', { ...budgetRun, fixture: true, prompt: 'Read the board', maxModelCalls: 1 })
  const exhausted = await finished(budget)
  assert.equal(exhausted.result.type, 'session.execution.failed')
  assert.equal(modelRequests - beforeBudget, 1, 'The budget must reject the second upstream request')
  console.log('PASS: the model hook prevents requests beyond the admitted call budget')
  const cancelled = randomUUID(), cancelRun = await gateway.run()
  const beforeCancellation = modelRequests
  holdModel = true
  await request(cancelled, '/start', { ...cancelRun, fixture: true, prompt: 'Wait for cancellation' })
  await until(() => modelRequests > beforeCancellation, 'No model request')
  await request(cancelled, '/cancel', {})
  const stopped = await finished(cancelled)
  assert.equal(stopped.result.type, 'session.execution.interrupted')
  holdModel = false
  console.log('PASS: active OpenCode model execution can be interrupted')
} finally {
  await kill()
  server.closeAllConnections(); server.close(); gateway.db.close()
  if (!process.env.L4_KEEP_PROBE) await rm(root, { recursive: true, force: true })
}
