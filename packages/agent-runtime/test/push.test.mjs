import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createPushBatcher } from '../src/push.mjs'

const settle = ms => new Promise(resolve => setTimeout(resolve, ms))
/** A Run's events endpoint that keeps what follows what it holds, as the Run's Durable Object does. */
function runEndpoint({ fail = 0, status, cancelAt, steer = [], holdAck } = {}) {
  const bodies = [], held = []
  let result = null
  const fetcher = async (url, init) => {
    const body = JSON.parse(init.body)
    bodies.push({ url, authorization: init.headers.Authorization, ...body })
    if (fail > 0) { fail--; throw new Error('Connection reset') }
    if (status) return new Response('', { status })
    if (body.from <= held.length) {
      held.push(...body.events.slice(held.length - body.from))
      if (body.result && !result) result = body.result
    }
    const ack = holdAck ? Math.min(held.length, holdAck(bodies.length)) : held.length
    return Response.json({ ack, cancel: cancelAt !== undefined && bodies.length >= cancelAt, steer })
  }
  return { fetcher, bodies, held, get result() { return result } }
}
const options = { url: 'https://server.example/api/agent-runs/r/gateway/events', token: 'run-capability', batchMs: 5, retryMs: 5, heartbeatMs: 1000 }

test('events go out in order, text deltas joined while they wait, and the result last', async () => {
  const run = runEndpoint()
  const batcher = createPushBatcher({ ...options, fetcher: run.fetcher })
  for (const text of ['Hel', 'lo', ' there']) batcher.push({ type: 'text', text })
  batcher.push({ type: 'tool', name: 'bash' })
  batcher.push({ type: 'text', text: 'Done' })
  await settle(30)
  assert.equal(run.bodies.length, 1)
  assert.deepEqual(run.bodies[0], { url: options.url, authorization: 'Bearer run-capability', from: 0,
    events: [{ type: 'text', text: 'Hello there' }, { type: 'tool', name: 'bash' }, { type: 'text', text: 'Done' }] })
  batcher.push({ type: 'text', text: '!' })
  assert.equal(await batcher.finish({ type: 'result', text: 'Hello there\nDone!', steps: 2 }), true)
  assert.deepEqual(run.bodies.at(-1), { url: options.url, authorization: 'Bearer run-capability', from: 3, events: [{ type: 'text', text: '!' }], result: { type: 'result', text: 'Hello there\nDone!', steps: 2 } })
  assert.equal(run.held.length, 4)
  assert.deepEqual(run.result, { type: 'result', text: 'Hello there\nDone!', steps: 2 })
})

test('a lost answer is sent again from the same point, and the Run never doubles text', async () => {
  const run = runEndpoint({ fail: 2 })
  const batcher = createPushBatcher({ ...options, fetcher: run.fetcher })
  batcher.push({ type: 'text', text: 'Once' })
  assert.equal(await batcher.finish({ type: 'result', text: 'Once', steps: 1 }), true)
  assert.equal(run.bodies.length, 3)
  assert.ok(run.bodies.every(body => body.from === 0 && JSON.stringify(body.events) === JSON.stringify([{ type: 'text', text: 'Once' }])))
  assert.deepEqual(run.held, [{ type: 'text', text: 'Once' }])
})

test('what the Run acknowledges decides where the next request starts', async () => {
  // The Run takes one event per request: the rest is sent again from what it holds.
  const run = runEndpoint({ holdAck: count => count })
  const batcher = createPushBatcher({ ...options, fetcher: run.fetcher })
  batcher.push({ type: 'tool', name: 'read' })
  batcher.push({ type: 'tool', name: 'edit' })
  batcher.push({ type: 'tool', name: 'bash' })
  assert.equal(await batcher.finish({ type: 'error', message: 'Failed' }), true)
  assert.deepEqual(run.bodies.map(body => body.from), [0, 1, 2])
  assert.deepEqual(run.bodies.map(body => body.events.length), [3, 2, 1])
  assert.deepEqual(run.held.map(event => event.name), ['read', 'edit', 'bash'])
  assert.equal(batcher.acknowledged, 3)
})

test('a long answer travels in events the Server accepts', async () => {
  const run = runEndpoint()
  const batcher = createPushBatcher({ ...options, fetcher: run.fetcher })
  batcher.push({ type: 'text', text: 'x'.repeat(70000) })
  assert.equal(await batcher.finish({ type: 'result', text: 'x', steps: 1 }), true)
  assert.deepEqual(run.held.map(event => event.text.length), [32000, 32000, 6000])
})

test('cancellation and new steering arrive in the answers, each once', async () => {
  const steer = [{ messageId: 'before', content: 'Already in the submission' }, { messageId: 'later', content: 'Also update the docs' }]
  const run = runEndpoint({ cancelAt: 2, steer })
  const cancels = [], steered = []
  const batcher = createPushBatcher({ ...options, fetcher: run.fetcher, steered: ['before'], onCancel: () => cancels.push(true), onSteer: message => steered.push(message) })
  batcher.push({ type: 'text', text: 'One' })
  await settle(30)
  batcher.push({ type: 'text', text: 'Two' })
  await settle(30)
  batcher.push({ type: 'text', text: 'Three' })
  assert.equal(await batcher.finish({ type: 'error', message: 'Run cancelled' }), true)
  assert.deepEqual(steered, [{ messageId: 'later', content: 'Also update the docs' }])
  assert.equal(cancels.length, 1)
  assert.equal(batcher.cancelled, true)
})

test('with nothing to send, a heartbeat keeps the box listening', async () => {
  const run = runEndpoint({ cancelAt: 1 })
  let cancelled = false
  const batcher = createPushBatcher({ ...options, heartbeatMs: 10, fetcher: run.fetcher, onCancel: () => { cancelled = true } })
  await settle(60)
  batcher.close()
  assert.ok(run.bodies.length >= 1)
  assert.deepEqual(run.bodies[0], { url: options.url, authorization: 'Bearer run-capability', from: 0, events: [] })
  assert.equal(cancelled, true)
})

test('a refused capability ends the push instead of retrying', async () => {
  const run = runEndpoint({ status: 401 })
  const batcher = createPushBatcher({ ...options, fetcher: run.fetcher })
  batcher.push({ type: 'text', text: 'Lost' })
  assert.equal(await batcher.finish({ type: 'result', text: 'Lost', steps: 1 }), false)
  const sent = run.bodies.length
  await settle(30)
  assert.equal(run.bodies.length, sent)
})
