import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mcpFixture, ids } from '../helpers/outbound-mcp'
import { ALL_PERMISSIONS } from '../../shared/permissions'
import { factoryHash } from '../../server/utils/factory-authority'
import { computePoll } from '../../server/utils/compute-nodes'
import { BOX_LEASE_MS, ensureBox } from '../../server/utils/factory-boxes'
import { BOX_WAITING_DETAIL } from '../../server/utils/box-admission'
import { agentGateway } from '../../server/utils/agent-gateway'
import { findAgentRun, runCapability } from '../../server/utils/agent-run-service'
import type { AgentRun, RuntimeEvent } from '../../shared/agent-execution'

vi.mock('cloudflare:workers', () => ({ DurableObject: class { constructor(protected ctx: unknown, protected env: unknown) {} } }))
vi.mock('../../workers/agent-pi-durable', () => ({ runEmbeddedPi: vi.fn() }))
const { AgentRunDurableObject } = await import('../../workers/agent-run-do')

const nodeId = '00000000-0000-4000-8000-000000000099', image = 'registry.example/l4@sha256:' + 'a'.repeat(64)
const capabilities = { diskBytes: 10737418240, docker: true, durableDisk: true, isolation: 'shared-kernel', image, capacity: { cpu: 4, memoryMiB: 16384, boxes: 4 }, protocol: 2 }
const capacity = (boxes = 4) => ({ cpu: 4, memoryMiB: 16384, boxes, diskFree: 50000000000 })
const config = { name: 'Afterprompt', computeNodeId: nodeId, sourceRepo: 'inchidev/afterprompt', sourceRepoId: 11, sourceInstallationId: 101,
  workRepo: 'inchidev/afterprompt', workRepoId: 11, workInstallationId: 101, baseBranch: 'main', requiredChecks: ['test'], previewHosts: [] }
const submission = (runId: string) => ({ runId, modelGateway: { url: `https://server.example/api/agent-runs/${runId}/gateway/v1`, token: 'run-capability-stays-in-the-run', model: 'm' }, computer: true, box: true })

let f: ReturnType<typeof mcpFixture>
const streamed: Array<{ runId: string; text: string }> = []
const runObjects = new Map<string, InstanceType<typeof AgentRunDurableObject>>()

/** A Durable Object storage on SQLite, as the Run's blobs need. */
function storage() {
  const db = new DatabaseSync(':memory:'), values = new Map<string, unknown>(), alarms: number[] = []
  return { alarms, values, storage: {
    sql: { exec(query: string, ...args: Array<string | number>) {
      const statement = db.prepare(query)
      if (statement.columns().length) return { toArray: () => statement.all(...args) }
      statement.run(...args)
    } },
    transactionSync<T>(callback: () => T) { db.exec('BEGIN'); try { const result = callback(); db.exec('COMMIT'); return result } catch (error) { db.exec('ROLLBACK'); throw error } },
    get: async (key: string) => values.get(key), put: async (key: string, value: unknown) => { values.set(key, value) }, delete: async (key: string) => values.delete(key),
    setAlarm: async (at: number) => { alarms.push(at) }, deleteAlarm: async () => {},
  } }
}
function runObject(runId: string) {
  const state = storage()
  state.values.set('runId', runId)
  const object = new AgentRunDurableObject({ storage: state.storage, waitUntil: (promise: Promise<unknown>) => { void promise.catch(() => {}) } } as unknown as DurableObjectState, f.env)
  runObjects.set(runId, object)
  return { object, state }
}

async function taskRun(taskId: string) {
  f.db.prepare("INSERT INTO tasks(id,board_id,title,assignee_id,created_by,status) VALUES(?,?,?,?,?,'ready')").run(taskId, 'factory-board', 'Ship ' + taskId, ids.agent, ids.owner)
  const created = await f.run(ids.owner, undefined, taskId)
  f.db.prepare('UPDATE tasks SET environment_id=? WHERE id=?').run('factory-env', taskId)
  const mandate = { ...JSON.parse(created.run.mandateJson), environmentId: 'factory-env', environmentVersion: 1 }
  f.db.prepare('UPDATE agent_runs SET environment_json=?,mandate_json=? WHERE id=?')
    .run(JSON.stringify({ ...config, id: 'factory-env', enabled: true, version: 1, baseSha: 'a'.repeat(40), baseTreeSha: 'b'.repeat(40) }), JSON.stringify(mandate), created.run.id)
  // The turn a mention shows in the conversation; its message is not part of this test.
  f.db.exec('PRAGMA foreign_keys=OFF')
  f.db.prepare("INSERT INTO agent_turns(submission_id,agent_id,channel_id,source_message_id,initiated_by,status,detail,created_at,updated_at) VALUES(?,?,?,?,?,'thinking','Working',?,?)")
    .run(created.run.id, ids.agent, 'public-chat', 'message-' + taskId, ids.owner, new Date().toISOString(), new Date().toISOString())
  f.db.exec('PRAGMA foreign_keys=ON')
  const run = (await findAgentRun(f.env, created.run.id))!
  expect(JSON.parse(run.mandateJson).computer).toBe(true)
  return run
}
const sync = (boxes: Array<{ id: string; lease: string; state: 'starting' | 'running' | 'idle' | 'stopped' | 'failed'; runId?: string; runtimeMs?: number }> = [], boxCount = 4) =>
  computePoll(f.env, nodeId, { operation: 'sync', capacity: capacity(boxCount), boxes: boxes.map(box => ({ runtimeMs: 0, ...box })) }) as Promise<{ boxes: Array<{ id: string; lease: string; want: string; turn?: { runId: string }; cancelRunId?: string; cpu: number; memoryMiB: number; taskId: string }> }>
const box = (id: string) => f.db.prepare('SELECT status,lease_token AS leaseToken,lease_until AS leaseUntil,run_id AS runId,runtime_ms AS runtimeMs FROM factory_boxes WHERE id=?').get(id) as { status: string; leaseToken: string | null; leaseUntil: string | null; runId: string | null; runtimeMs: number }
const detail = (runId: string) => (f.db.prepare('SELECT detail FROM agent_turns WHERE submission_id=?').get(runId) as { detail: string }).detail

beforeEach(async () => {
  f = mcpFixture()
  streamed.length = 0; runObjects.clear()
  f.db.prepare('UPDATE roles SET permissions_bitmask=? WHERE id=?').run(ALL_PERMISSIONS, ids.agentRole)
  f.db.prepare('INSERT INTO task_boards(id,name,created_by) VALUES(?,?,?)').run('factory-board', 'Factory', ids.owner)
  f.db.prepare('INSERT INTO compute_nodes(id,name,token_hash,capabilities_json,last_seen,created_by,created_at) VALUES(?,?,?,?,?,?,?)').run(nodeId, 'VPS', await factoryHash('node-token'), JSON.stringify(capabilities), new Date().toISOString(), ids.owner, new Date().toISOString())
  f.db.prepare('INSERT INTO agent_environments(id,config_json,created_by,created_at,updated_at) VALUES(?,?,?,?,?)').run('factory-env', JSON.stringify(config), ids.owner, new Date().toISOString(), new Date().toISOString())
  Object.assign(f.env, {
    AGENT_RUN_DO: { getByName: (name: string) => runObjects.get(name.replace(/^run:/u, '')) ?? { wake: async () => {} } },
    CHANNEL_DO: { getByName: () => ({ fanout: async () => {}, endAgentStream: async () => {}, postAgentMessage: async () => ({}),
      streamAgentReply: async (input: { runId: string; text: string }) => { streamed.push({ runId: input.runId, text: input.text }) } }) },
  })
})
afterEach(() => { vi.useRealTimers(); f.db.close() })

describe('a box on its Node', () => {
  it('admits a Run’s box on sync, hands over its turn and renews the lease while the Node lists it', async () => {
    const run = await taskRun('factory-task-a')
    const id = await ensureBox(f.env, run, nodeId)
    const [first] = (await sync()).boxes
    expect(first).toMatchObject({ id, want: 'running', turn: { runId: run.id }, taskId: 'factory-task-a', cpu: 1, memoryMiB: 4096 })
    expect(first!.lease).toMatch(/^[a-f0-9]{64}$/u)
    expect(box(id)).toMatchObject({ status: 'starting', leaseToken: first!.lease })
    const before = Date.parse(box(id).leaseUntil!)
    await new Promise(resolve => setTimeout(resolve, 5))
    const [renewed] = (await sync([{ id, lease: first!.lease, state: 'running', runId: run.id, runtimeMs: 1500 }])).boxes
    expect(renewed).toMatchObject({ id, lease: first!.lease, want: 'running', turn: { runId: run.id } })
    expect(renewed).not.toHaveProperty('cancelRunId')
    expect(box(id)).toMatchObject({ status: 'running', runtimeMs: 1500 })
    expect(Date.parse(box(id).leaseUntil!)).toBeGreaterThan(before)
    expect(Date.parse(box(id).leaseUntil!)).toBeLessThanOrEqual(Date.now() + BOX_LEASE_MS)
    // The Node's reported capacity is what the next admission uses.
    expect(JSON.parse((f.db.prepare('SELECT capabilities_json AS c FROM compute_nodes WHERE id=?').get(nodeId) as { c: string }).c).capacity).toEqual({ cpu: 4, memoryMiB: 16384, boxes: 4 })
  })

  it('gives the turn’s submission only to the Node holding the lease, and never writes it to D1', async () => {
    const run = await taskRun('factory-task-a')
    const { state } = runObject(run.id)
    state.values.set('box', true)
    const id = await ensureBox(f.env, run, nodeId)
    const [granted] = (await sync()).boxes
    await expect(computePoll(f.env, nodeId, { operation: 'turn', boxId: id, lease: granted!.lease, runId: run.id })).rejects.toMatchObject({ statusCode: 409 })
    const { putRunBlob } = await import('../../workers/agent-run-storage')
    await putRunBlob(state.storage as unknown as DurableObjectStorage, 'pi-embedded-input', submission(run.id))
    await expect(computePoll(f.env, nodeId, { operation: 'turn', boxId: id, lease: 'f'.repeat(64), runId: run.id })).rejects.toMatchObject({ statusCode: 403 })
    expect(await computePoll(f.env, nodeId, { operation: 'turn', boxId: id, lease: granted!.lease, runId: run.id })).toEqual({ submission: submission(run.id) })
    const dump = JSON.stringify(f.db.prepare('SELECT * FROM factory_boxes').all()) + JSON.stringify(f.db.prepare('SELECT * FROM compute_nodes').all())
    expect(dump).not.toContain('run-capability-stays-in-the-run')
  })

  it('queues boxes beyond the Node’s capacity with a waiting detail, and admits them when a box stops', async () => {
    const one = await taskRun('factory-task-a'), two = await taskRun('factory-task-b')
    const first = await ensureBox(f.env, one, nodeId)
    await new Promise(resolve => setTimeout(resolve, 5))
    const second = await ensureBox(f.env, two, nodeId)
    const answer = await sync([], 1)
    expect(answer.boxes.map(entry => entry.id)).toEqual([first])
    expect(box(second).status).toBe('queued')
    expect(detail(two.id)).toBe(BOX_WAITING_DETAIL)
    // The first turn ends; its box idles and still holds its share until the Node stops it.
    f.db.prepare("UPDATE agent_runs SET status='completed' WHERE id=?").run(one.id)
    const lease = answer.boxes[0]!.lease
    expect((await sync([{ id: first, lease, state: 'idle', runId: one.id }], 1)).boxes).toEqual([expect.objectContaining({ id: first, want: 'running', cancelRunId: one.id })])
    expect(box(second).status).toBe('queued')
    const freed = await sync([{ id: first, lease, state: 'stopped' }], 1)
    expect(freed.boxes).toEqual(expect.arrayContaining([expect.objectContaining({ id: first, want: 'stopped' }), expect.objectContaining({ id: second, want: 'running', turn: { runId: two.id } })]))
    expect(box(second).status).toBe('starting')
    expect(detail(two.id)).toBe('Working')
  })

  it('stops a box whose lease ran out, and lets the Node take over a new lease when it is admitted again', async () => {
    const run = await taskRun('factory-task-a'), other = await taskRun('factory-task-b')
    const id = await ensureBox(f.env, run, nodeId)
    const [granted] = (await sync([], 1)).boxes
    f.db.prepare('UPDATE factory_boxes SET lease_until=? WHERE id=?').run(new Date(Date.now() - 1000).toISOString(), id)
    // While it was gone, another Task queued for the only box. Its earlier place in the queue is explicit:
    // in one millisecond both rows would tie on updated_at and the order would fall to their random ids.
    const otherId = await ensureBox(f.env, other, nodeId)
    f.db.prepare('UPDATE factory_boxes SET updated_at=? WHERE id=?').run(new Date(Date.now() - 500).toISOString(), otherId)
    const late = await sync([{ id, lease: granted!.lease, state: 'running', runId: run.id }], 1)
    expect(late.boxes.find(entry => entry.id === id)).toMatchObject({ want: 'stopped', lease: granted!.lease })
    expect(box(id)).toMatchObject({ status: 'queued', leaseToken: null })
    expect(detail(run.id)).toBe(BOX_WAITING_DETAIL)
    // The other box ends and stops; this one is admitted under a new lease, which the Node takes over.
    const otherBox = late.boxes.find(entry => entry.id !== id)!
    f.db.prepare("UPDATE agent_runs SET status='completed' WHERE id=?").run(other.id)
    const back = await sync([{ id, lease: granted!.lease, state: 'stopped' }, { id: otherBox.id, lease: otherBox.lease, state: 'stopped' }], 1)
    const again = back.boxes.find(entry => entry.id === id)!
    expect(again).toMatchObject({ want: 'running', turn: { runId: run.id } })
    expect(again.lease).not.toBe(granted!.lease)
  })

  it('releases the box of a Done Task and never reuses it', async () => {
    const run = await taskRun('factory-task-a')
    const id = await ensureBox(f.env, run, nodeId)
    const [granted] = (await sync()).boxes
    f.db.prepare("UPDATE agent_runs SET status='completed' WHERE id=?").run(run.id)
    f.db.prepare("UPDATE tasks SET status='done' WHERE id='factory-task-a'").run()
    expect((await sync([{ id, lease: granted!.lease, state: 'idle' }])).boxes).toEqual([expect.objectContaining({ id, want: 'released' })])
    expect(box(id).status).toBe('released')
    f.db.prepare("UPDATE tasks SET status='ready',environment_id=NULL WHERE id='factory-task-a'").run()
    const next = await f.run(ids.owner, undefined, 'factory-task-a')
    f.db.prepare('UPDATE agent_runs SET environment_json=? WHERE id=?').run(run.environmentJson, next.run.id)
    await expect(ensureBox(f.env, (await findAgentRun(f.env, next.run.id))!, nodeId)).rejects.toMatchObject({ statusCode: 403 })
  })
})

describe('a box reporting its turn', () => {
  async function boxTurn() {
    const run = await taskRun('factory-task-a')
    const { object, state } = runObject(run.id)
    state.values.set('box', true)
    const { putRunBlob, getRunBlob } = await import('../../workers/agent-run-storage')
    await putRunBlob(state.storage as unknown as DurableObjectStorage, 'pi-embedded-input', submission(run.id))
    const events = async () => await getRunBlob<RuntimeEvent[]>(state.storage as unknown as DurableObjectStorage, 'pi-embedded-events') ?? []
    const gateway = async (body: unknown, current: AgentRun = run) => (await agentGateway(new Request(`https://server.example/api/agent-runs/${current.id}/gateway/events`, {
      method: 'POST', headers: { Authorization: 'Bearer ' + await runCapability(f.env, current.id) }, body: JSON.stringify(body) }), f.env, current.id, 'events', () => {})).json()
    return { run, object, state, events, gateway }
  }

  it('keeps events idempotently across resends and gaps, and wakes the Run on its result', async () => {
    const t = await boxTurn()
    expect(await t.gateway({ from: 0, events: [{ type: 'text', text: 'Hel' }, { type: 'text', text: 'lo' }] })).toEqual({ ack: 2, cancel: false, steer: [] })
    // The answer was lost: the box sends the same events again, with one more.
    expect(await t.gateway({ from: 0, events: [{ type: 'text', text: 'Hel' }, { type: 'text', text: 'lo' }, { type: 'tool', name: 'bash' }] })).toMatchObject({ ack: 3 })
    // A batch after a gap is not kept; the box resends from the ack.
    expect(await t.gateway({ from: 7, events: [{ type: 'text', text: 'lost' }], result: { type: 'result', text: 'Done', steps: 1 } })).toMatchObject({ ack: 3 })
    expect(await t.events()).toEqual([{ type: 'text', text: 'Hel' }, { type: 'text', text: 'lo' }, { type: 'tool', name: 'bash' }])
    expect(t.state.alarms).toEqual([])
    expect(await t.gateway({ from: 3, events: [], result: { type: 'result', text: 'Done', steps: 1 } })).toMatchObject({ ack: 3 })
    expect(t.state.alarms.length).toBe(1)
    expect(t.state.alarms[0]!).toBeLessThanOrEqual(Date.now())
    // The Run reads the box's events exactly as it reads embedded Pi's.
    const poll = await (await (t.object as unknown as { runtime: (run: AgentRun, path: string) => Promise<Response> }).runtime(t.run, 'run?after=1')).json()
    expect(poll).toEqual({ status: 'finished', events: [{ type: 'text', text: 'lo' }, { type: 'tool', name: 'bash' }], nextCursor: 3, result: { type: 'result', text: 'Done', steps: 1 } })
    // Malformed reports are refused before they reach the Run.
    expect((await agentGateway(new Request(`https://server.example/api/agent-runs/${t.run.id}/gateway/events`, { method: 'POST', headers: { Authorization: 'Bearer ' + await runCapability(f.env, t.run.id) }, body: JSON.stringify({ from: 0, events: [{ type: 'shell', command: 'rm' }] }) }), f.env, t.run.id, 'events', () => {})).status).toBe(400)
  })

  it('piggybacks steering and cancellation on the answer to the box’s events and on the Node’s sync', async () => {
    const t = await boxTurn()
    expect(await t.object.steer('message-1', 'Use the staging branch', ids.owner)).toBe(true)
    expect(await t.object.steer('message-1', 'Use the staging branch', ids.owner)).toBe(true)
    expect(await t.gateway({ from: 0, events: [] })).toEqual({ ack: 0, cancel: false, steer: [{ messageId: 'message-1', content: 'Use the staging branch' }] })
    const id = await ensureBox(f.env, t.run, nodeId)
    const [granted] = (await sync()).boxes
    await t.object.cancel()
    expect(f.db.prepare('SELECT status FROM agent_runs WHERE id=?').get(t.run.id)).toEqual({ status: 'cancelled' })
    expect(await t.gateway({ from: 0, events: [{ type: 'text', text: 'late' }] })).toEqual({ ack: 0, cancel: true, steer: [] })
    expect(await t.object.boxEvents(t.run.id, 0, [])).toMatchObject({ cancel: true })
    expect((await sync([{ id, lease: granted!.lease, state: 'running', runId: t.run.id }])).boxes).toEqual([expect.objectContaining({ id, want: 'running', cancelRunId: t.run.id })])
    expect(box(id).runId).toBeNull()
  })

  it('answers only for the Run whose turn the box holds', async () => {
    const t = await boxTurn()
    expect(await t.object.boxEvents('00000000-0000-4000-8000-0000000000aa', 0, [])).toBeNull()
    expect(await t.object.boxSubmission('00000000-0000-4000-8000-0000000000aa')).toBeNull()
    t.state.values.set('box', false)
    const refused = await agentGateway(new Request(`https://server.example/api/agent-runs/${t.run.id}/gateway/events`, { method: 'POST', headers: { Authorization: 'Bearer ' + await runCapability(f.env, t.run.id) }, body: JSON.stringify({ from: 0, events: [] }) }), f.env, t.run.id, 'events', () => {})
    expect(refused.status).toBe(409)
    expect(await t.object.boxSession(t.run.id, '{}')).toBe(false)
    // Without the Run's capability the gateway answers nothing at all.
    expect((await agentGateway(new Request(`https://server.example/api/agent-runs/${t.run.id}/gateway/events`, { method: 'POST', headers: { Authorization: 'Bearer ' + 'f'.repeat(64) }, body: '{}' }), f.env, t.run.id, 'events', () => {})).status).toBe(401)
  })
})
