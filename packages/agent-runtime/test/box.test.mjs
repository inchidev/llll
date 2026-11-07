import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { execFileSync } from 'node:child_process'
import { connect } from 'node:net'
import { mkdtemp, mkdir, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { boxRuntime, serveControl } from '../src/box.mjs'

/** The Server's gateway for one Run: its model, tools, events and session, as a box sees them. */
async function gateway({ replies, cancel = false }) {
  const events = [], sessions = [], order = [], models = []
  let result = null
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk)
    const body = Buffer.concat(chunks).toString()
    const operation = request.url.replace(/^\/api\/agent-runs\/[^/]+\/gateway\//u, '')
    if (request.headers.authorization !== 'Bearer run-capability-for-this-turn') { response.writeHead(401).end(); return }
    if (operation === 'tools' && request.method === 'GET') { response.writeHead(405).end(); return }
    if (operation === 'session') { sessions.push(body); order.push('session'); response.end('{"ok":true}'); return }
    if (operation === 'events') {
      const input = JSON.parse(body)
      if (input.from <= events.length) { events.push(...input.events.slice(events.length - input.from)); if (input.result && !result) { result = input.result; order.push('result') } }
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ack: events.length, cancel, steer: [] }))
      return
    }
    models.push(JSON.parse(body))
    const reply = replies[Math.min(models.length, replies.length) - 1]
    const delta = reply.tool ? { role: 'assistant', tool_calls: [{ index: 0, id: `call-${models.length}`, type: 'function', function: { name: reply.tool, arguments: JSON.stringify(reply.arguments) } }] } : { role: 'assistant', content: reply.text }
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    for (const choice of [{ delta, finish_reason: null }, { delta: {}, finish_reason: reply.tool ? 'tool_calls' : 'stop' }]) response.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, ...choice }] })}\n\n`)
    response.end('data: [DONE]\n\n')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  return { origin, events, sessions, order, models, get result() { return result },
    close: async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) } }
}
const submission = (origin, runId = randomUUID()) => ({ runId, sessionId: randomUUID(), prompt: 'Run the tests', instructions: 'Work in the checkout.', computer: true, box: true, maxSteps: 4,
  modelGateway: { url: `${origin}/api/agent-runs/${runId}/gateway/v1`, token: 'run-capability-for-this-turn', model: 'fixture' },
  toolEndpoint: `${origin}/api/agent-runs/${runId}/gateway/tools`, tools: [], timeoutMs: 30000 })
async function boxRoot() {
  const root = await mkdtemp(join(tmpdir(), 'llll-box-'))
  await mkdir(join(root, 'repo'))
  execFileSync('git', ['init', '-q'], { cwd: join(root, 'repo') })
  return root
}
const batch = { batchMs: 5, retryMs: 5, heartbeatMs: 1000 }

test('a box turn works in its checkout and reports to the Run: events, then the session, then the result', async () => {
  const run = await gateway({ replies: [{ tool: 'bash', arguments: { command: 'echo checked > status.txt && git status --short' } }, { text: 'Tests pass.' }] })
  const root = await boxRoot()
  try {
    const box = boxRuntime({ root, batch })
    assert.deepEqual(await box.health(), { status: 'ready', checkout: true })
    const started = await box.turn(submission(run.origin))
    assert.equal(started.accepted, true)
    assert.equal((await box.health()).status, 'running')
    assert.deepEqual(await started.done, { ok: true, result: 'result' })
    assert.equal(await readFile(join(root, 'repo/status.txt'), 'utf8'), 'checked\n')
    assert.deepEqual(run.result, { type: 'result', text: 'Tests pass.', steps: 2 })
    assert.ok(run.events.some(event => event.type === 'tool' && event.name === 'bash'))
    assert.equal(run.events.filter(event => event.type === 'text').map(event => event.text).join(''), 'Tests pass.')
    assert.deepEqual(run.order, ['session', 'result'])
    assert.ok(run.sessions[0].includes('Run the tests') && !run.sessions[0].includes('run-capability-for-this-turn'))
    assert.deepEqual(await box.health(), { status: 'ready', checkout: true })
    // The Run's capability lives only in the turn's memory: nothing on the Task disk holds it.
    const files = (await readdir(root, { recursive: true, withFileTypes: true })).filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name))
    assert.ok(files.some(file => file.includes('/.l4/')))
    for (const file of files) assert.ok(!(await readFile(file, 'utf8')).includes('run-capability-for-this-turn'), file)
  } finally { await run.close(); await rm(root, { recursive: true, force: true }) }
})

test('a turn that began before the box stopped is never run again', async () => {
  const run = await gateway({ replies: [{ text: 'First time.' }] })
  const root = await boxRoot()
  try {
    const input = submission(run.origin)
    assert.equal((await (await boxRuntime({ root, batch }).turn(input)).done).ok, true)
    const models = run.models.length
    // The same turn handed to a box started again on this disk ends with an error, not a second run.
    const again = await boxRuntime({ root, batch }).turn(input)
    assert.equal((await again.done).result, 'error')
    assert.equal(run.models.length, models)
  } finally { await run.close(); await rm(root, { recursive: true, force: true }) }
})

test('a box refuses a turn without native tools, without a checkout, or while another runs', async () => {
  const run = await gateway({ replies: [{ tool: 'bash', arguments: { command: 'sleep 0.3' } }, { text: 'Done.' }] })
  const root = await boxRoot()
  try {
    const box = boxRuntime({ root, batch })
    assert.equal((await box.turn({ ...submission(run.origin), computer: false, box: false })).accepted, false)
    const empty = await mkdtemp(join(tmpdir(), 'llll-box-empty-'))
    assert.deepEqual(await boxRuntime({ root: empty }).turn(submission(run.origin)), { accepted: false, error: 'The box has no checkout' })
    await rm(empty, { recursive: true, force: true })
    const first = submission(run.origin), started = await box.turn(first)
    assert.equal((await box.turn(submission(run.origin))).accepted, false)
    // The same turn asked again joins the one running.
    assert.equal((await box.turn(first)).done, started.done)
    await started.done
  } finally { await run.close(); await rm(root, { recursive: true, force: true }) }
})

test('the daemon cancels a turn through the control socket, and the Run hears why it ended', async () => {
  const run = await gateway({ replies: [{ tool: 'bash', arguments: { command: 'sleep 5' } }, { text: 'Too late.' }] })
  const root = await boxRoot(), socket = join(root, 'control.sock')
  const server = serveControl(boxRuntime({ root, batch }))
  await new Promise(resolve => server.listen(socket, resolve))
  const ask = request => new Promise((resolve, reject) => {
    const lines = []
    let buffer = ''
    const connection = connect(socket, () => connection.write(JSON.stringify(request) + '\n'))
    connection.setEncoding('utf8')
    connection.on('data', chunk => { buffer += chunk; for (let end; (end = buffer.indexOf('\n')) >= 0; buffer = buffer.slice(end + 1)) lines.push(JSON.parse(buffer.slice(0, end))) })
    connection.on('error', reject)
    connection.on('close', () => resolve(lines))
  })
  try {
    const input = submission(run.origin)
    const turn = ask({ op: 'turn', submission: input })
    while (!run.models.length) await new Promise(resolve => setTimeout(resolve, 10))
    assert.deepEqual(await ask({ op: 'health' }), [{ status: 'running', runId: input.runId, checkout: true }])
    assert.deepEqual(await ask({ op: 'cancel', runId: randomUUID() }), [{ ok: false }])
    assert.deepEqual(await ask({ op: 'cancel', runId: input.runId }), [{ ok: true }])
    assert.deepEqual(await turn, [{ accepted: true }, { done: true, ok: true, result: 'error' }])
    assert.deepEqual(run.result, { type: 'error', message: 'Run cancelled' })
    assert.deepEqual(await ask({ op: 'unknown' }), [{ error: 'Unknown operation' }])
  } finally { server.close(); await run.close(); await rm(root, { recursive: true, force: true }) }
})
