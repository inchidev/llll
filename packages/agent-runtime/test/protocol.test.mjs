import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { runtimeInput } from '../src/protocol.mjs'

test('runtime admission rejects native computer authority before starting a Run', () => {
  const input = { runId: randomUUID(), sessionId: randomUUID(), prompt: 'Inspect the Task', instructions: '',
    modelGateway: { url: 'http://gateway/v1', token: 'fixture-token-32-characters-long', model: 'fixture' },
    toolEndpoint: 'http://gateway/tools', tools: [] }
  assert.equal(runtimeInput.parse(input).computer, false)
  assert.equal(runtimeInput.parse({ ...input, computer: false }).computer, false)
  for (const computer of [true, 'true', 1, {}]) assert.equal(runtimeInput.safeParse({ ...input, computer }).success, false)
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
