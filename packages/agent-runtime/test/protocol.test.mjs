import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { runtimeInput } from '../src/protocol.mjs'

test('runtime admission allows native computer tools only on a box', () => {
  const input = { runId: randomUUID(), sessionId: randomUUID(), prompt: 'Inspect the Task', instructions: '',
    modelGateway: { url: 'http://gateway/v1', token: 'fixture-token-32-characters-long', model: 'fixture' },
    toolEndpoint: 'http://gateway/tools', tools: [] }
  assert.deepEqual([runtimeInput.parse(input).computer, runtimeInput.parse(input).box], [false, false])
  assert.equal(runtimeInput.parse({ ...input, computer: false }).computer, false)
  const box = runtimeInput.parse({ ...input, computer: true, box: true })
  assert.deepEqual([box.computer, box.box], [true, true])
  // Native tools without a box, or a box without them, are refused before a Run starts.
  for (const mode of [{ computer: true }, { computer: true, box: false }, { box: true }, { computer: false, box: true }]) assert.equal(runtimeInput.safeParse({ ...input, ...mode }).success, false, JSON.stringify(mode))
  for (const computer of ['true', 1, {}]) assert.equal(runtimeInput.safeParse({ ...input, computer, box: true }).success, false)
})

test('a box turn carries the steering sent so far, bounded', () => {
  const input = { runId: randomUUID(), sessionId: randomUUID(), prompt: 'Inspect the Task', instructions: '', computer: true, box: true,
    modelGateway: { url: 'http://gateway/v1', token: 'fixture-token-32-characters-long', model: 'fixture' }, toolEndpoint: 'http://gateway/tools', tools: [] }
  assert.deepEqual(runtimeInput.parse({ ...input, steering: [{ messageId: 'm1', content: 'Also the docs' }] }).steering, [{ messageId: 'm1', content: 'Also the docs' }])
  assert.equal(runtimeInput.safeParse({ ...input, steering: [{ messageId: 'm1', content: '' }] }).success, false)
  assert.equal(runtimeInput.safeParse({ ...input, steering: Array.from({ length: 21 }, (_, index) => ({ messageId: `m${index}`, content: 'x' })) }).success, false)
})

test('runtime admission takes the model limits the Server derived, and defaults older submissions', () => {
  const base = { runId: randomUUID(), sessionId: randomUUID(), prompt: 'Inspect the Task', instructions: '',
    modelGateway: { url: 'http://gateway/v1', token: 'fixture-token-32-characters-long', model: 'fixture' },
    toolEndpoint: 'http://gateway/tools', tools: [] }
  const old = runtimeInput.parse(base).modelGateway
  assert.equal(old.contextWindow, 64000)
  assert.equal(old.maxOutputTokens, 4096)
  assert.equal(old.compaction, undefined)
  const compaction = { reserveTokens: 32000, keepRecentTokens: 20000, backgroundTokens: 25000 }
  const parsed = runtimeInput.parse({ ...base, modelGateway: { ...base.modelGateway, contextWindow: 200000, maxOutputTokens: 32000, compaction } }).modelGateway
  assert.deepEqual([parsed.contextWindow, parsed.maxOutputTokens, parsed.compaction], [200000, 32000, compaction])
  assert.equal(runtimeInput.safeParse({ ...base, modelGateway: { ...base.modelGateway, apiKey: 'provider-key' } }).success, false)
})

test('a box turn may carry the whole tool catalog, up to the runtime limit', async () => {
  const { MAX_RUNTIME_TOOLS } = await import('../src/protocol.mjs')
  const tool = index => ({ name: `tool_${index}`, description: 'A tool', parameters: { type: 'object' }, deferred: true })
  const input = { runId: randomUUID(), sessionId: randomUUID(), prompt: 'Build it', instructions: '', computer: true, box: true,
    modelGateway: { url: 'http://gateway/v1', token: 'fixture-token-32-characters-long', model: 'fixture' }, toolEndpoint: 'http://gateway/tools' }
  assert.equal(runtimeInput.safeParse({ ...input, tools: Array.from({ length: 60 }, (_, index) => tool(index)) }).success, true)
  assert.equal(runtimeInput.safeParse({ ...input, tools: Array.from({ length: MAX_RUNTIME_TOOLS + 1 }, (_, index) => tool(index)) }).success, false)
})
