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
