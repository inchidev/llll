import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openPi } from '../src/pi.mjs'

test('real Pi SDK uses only explicit tools and restores its conversation after restart', async () => {
  const requests = []
  const gateways = []
  const model = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    requests.push(JSON.parse(Buffer.concat(chunks).toString()))
    gateways.push({ path: request.url, token: request.headers.authorization })
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    for (const choice of [
      { delta: { role: 'assistant', content: 'fixture result' }, finish_reason: null },
      { delta: {}, finish_reason: 'stop' },
    ]) response.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, ...choice }] })}\n\n`)
    response.end('data: [DONE]\n\n')
  })
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve))
  const directory = await mkdtemp(join(tmpdir(), 'llll-pi-'))
  const input = { modelGateway: { url: `http://127.0.0.1:${model.address().port}/v1`, model: 'fixture', token: 'fixture-gateway-token' },
    instructions: 'You are a fixture. Use only explicitly provided tools.', tools: [], computer: false, maxSteps: 3 }
  try {
    const events = []
    const dependencies = { directory, emit: event => events.push(event), callTool: async () => { throw new Error('Unexpected tool') } }
    const first = await openPi(input, dependencies)
    assert.equal((await first.run('First request')).text, 'fixture result')
    const next = { ...input, modelGateway: { ...input.modelGateway, url: input.modelGateway.url.replace('/v1', '/next/v1'), token: 'second-run-capability' } }
    const restored = await openPi(next, dependencies)
    assert.equal((await restored.run('Second request')).text, 'fixture result')
    assert.equal(requests.length, 2)
    assert.deepEqual(gateways, [{ path: '/v1/chat/completions', token: `Bearer ${input.modelGateway.token}` }, { path: '/next/v1/chat/completions', token: `Bearer ${next.modelGateway.token}` }])
    const saved = await readFile((await readFile(join(directory, 'session-path'), 'utf8')).trim(), 'utf8')
    assert.ok(!saved.includes(input.modelGateway.token) && !saved.includes(next.modelGateway.token))
    assert.ok(requests[1].messages.some(message => JSON.stringify(message.content).includes('First request')))
    assert.ok(requests[1].messages.some(message => JSON.stringify(message.content).includes('Second request')))
    assert.equal(requests[0].tools?.length || 0, 0)
    assert.ok(events.some(event => event.type === 'text'))
  } finally { model.closeAllConnections(); await new Promise(resolve => model.close(resolve)); await rm(directory, { recursive: true, force: true }) }
})

test('real Pi computer writes a file and reports its tool result to the next model turn', async () => {
  const requests = []
  const model = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk)
    const input = JSON.parse(Buffer.concat(chunks).toString()); requests.push(input)
    const used = input.messages.some(message => message.role === 'tool')
    const delta = used ? { role: 'assistant', content: 'Saved' } : { role: 'assistant', tool_calls: [{ index: 0, id: 'write-fixture', type: 'function', function: { name: 'write', arguments: JSON.stringify({ path: 'artifact.txt', content: 'Cloud evidence' }) } }] }
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    for (const choice of [{ delta, finish_reason: null }, { delta: {}, finish_reason: used ? 'stop' : 'tool_calls' }]) response.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, ...choice }] })}\n\n`)
    response.end('data: [DONE]\n\n')
  })
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve))
  const directory = await mkdtemp(join(tmpdir(), 'llll-pi-write-'))
  try {
    const input = { modelGateway: { url: `http://127.0.0.1:${model.address().port}/v1`, model: 'fixture', token: 'fixture-gateway-token' }, instructions: 'Write the requested file.', tools: [], computer: true, maxSteps: 3 }
    const pi = await openPi(input, { directory, emit: () => {}, callTool: async () => { throw new Error('Unexpected Server tool') } })
    assert.equal((await pi.run('Write artifact.txt')).text, 'Saved')
    assert.equal(await readFile(join(directory, 'work/artifact.txt'), 'utf8'), 'Cloud evidence')
    assert.ok(requests[1].messages.some(message => message.role === 'tool' && JSON.stringify(message.content).includes('artifact.txt')))
  } finally { model.closeAllConnections(); await new Promise(resolve => model.close(resolve)); await rm(directory, { recursive: true, force: true }) }
})
