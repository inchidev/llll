import { DatabaseSync } from 'node:sqlite'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { d1 } from '../helpers/sqlite-d1'
import { INIT_SQL } from '../../server/utils/db'
import { loadAuthorizationContext } from '../../server/utils/authorization'
import { createAgentRun } from '../../server/utils/agent-run-service'
import { AgentRunDurableObject } from '../../workers/agent-run-do'
import { Permission } from '../../shared/permissions'
import { updateTask } from '../../server/utils/task-service'
import { createError } from 'h3'
import type { L4Env } from '../../workers/env'
vi.mock('cloudflare:workers', () => ({ DurableObject: class {
  constructor(protected ctx: unknown, protected env: unknown) {}
} }))
vi.mock('../../workers/agent-pi-durable', () => ({ runEmbeddedPi: vi.fn() }))
let db: DatabaseSync, env: L4Env
const post = vi.fn(async () => ({ id: 'result', channelId: 'public-chat' }))
const agentId = '00000000-0000-4000-8000-000000000002'
beforeEach(() => {
  vi.stubGlobal('createError', createError)
  post.mockClear()
  db = new DatabaseSync(':memory:'); db.exec(INIT_SQL)
  db.exec(`INSERT INTO server_identity(singleton,id) VALUES(1,'00000000-0000-4000-8000-000000000001');
    INSERT INTO roles(id,key,name,permissions_bitmask,resource_access_json) VALUES('owner-role','owner','Owner',0,'{}'),
    ('agent-role','custom:agent','Task agent',${Permission.sendMessages | Permission.readTasks | Permission.executeTasks},'{}');
    INSERT INTO users(id,kind,display_name,status,role_id,joined_at) VALUES('owner-user','human','Owner','active','owner-role','2026-10-21'),
    ('${agentId}','agent','Pi','active','agent-role','2026-10-21');
    INSERT INTO server(id,name,owner_id) VALUES('00000000-0000-4000-8000-000000000001','L4','owner-user');
    INSERT INTO agents(user_id,created_by,harness,model) VALUES('${agentId}','owner-user','pi','');
    INSERT INTO channels(id,name,type,visibility) VALUES('public-chat','General','text','server');
    INSERT INTO task_boards(id,name,created_by) VALUES('board-allowed','Work','owner-user');
    INSERT INTO tasks(id,board_id,title,status,assignee_id,created_by,channel_id,created_at,updated_at)
      VALUES('assigned-task','board-allowed','Research','ready','${agentId}','owner-user','public-chat','2026-10-21','2026-10-21');`)
  env = { DB: d1(db), AUTH_SECRET: 'test-server-secret-with-32-characters', FILES: {}, AI: {}, AGENT_MODEL: '@cf/test',
    SERVER_DO: { getByName: () => ({ notifyTasksChanged: async () => {} }) },
    AGENT_RUN_DO: { getByName: () => ({ wake: async () => {} }) },
    SERVER_DO: { getByName: () => ({ notifyTasksChanged: async () => {} }) },
    AGENT_RUNNER_URL: 'http://runner', AGENT_RUNNER_TOKEN: 'fixture',
    CHANNEL_DO: { getByName: () => ({ postAgentMessage: post, fanout: async () => {} }) },
  } as unknown as L4Env
})
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); db.close() })
async function completed() {
  const actor = (await loadAuthorizationContext(env, { principalId: 'owner-user', credential: { kind: 'session' } }))!
  const run = await createAgentRun(env, actor, { agentId, channelId: 'public-chat', taskId: 'assigned-task', prompt: 'Research', idempotencyKey: 'fixture-request' })
  db.prepare("UPDATE agent_runs SET status='completed',result_text='Verified result',result_message_id='result' WHERE id=?").run(run.id)
  return run
}
function coordinator(id: string) {
  const ctx = { storage: { get: async () => id, setAlarm: async () => {}, deleteAlarm: async () => {} }, waitUntil: (p: Promise<unknown>) => { void p.catch(() => {}) } }
  return new AgentRunDurableObject(ctx as unknown as DurableObjectState, env)
}
it('records the assigned task result without granting general task-write permission', async () => {
  const run = await completed()
  await coordinator(run.id).alarm()
  expect(db.prepare("SELECT status,result_summary FROM tasks WHERE id='assigned-task'").get()).toMatchObject({ status: 'review', result_summary: 'Private result available to the initiating Member.' })
  expect(post).toHaveBeenCalledTimes(1)
  expect(JSON.stringify(post.mock.calls)).not.toContain('Verified result')
  expect(JSON.stringify(post.mock.calls)).toContain('Open private Run')
  const taskResult = db.prepare("SELECT result_summary,result_details,last_error FROM tasks WHERE id='assigned-task'").get()
  expect(JSON.stringify(taskResult)).not.toContain('Verified result')
  expect(JSON.stringify(taskResult)).toContain('Open private Run')
})
it('preserves the completed computation when reporting is denied and makes the failure visible', async () => {
  const run = await completed()
  post.mockRejectedValueOnce(new Error('Agent cannot send messages in this channel'))
  await coordinator(run.id).alarm()
  expect(db.prepare('SELECT status,result_text FROM agent_runs WHERE id=?').get(run.id)).toMatchObject({ status: 'completed', result_text: 'Verified result' })
  const { runDelivery } = await import('../../server/utils/agent-run-delivery')
  expect(await runDelivery(env, run.id)).toMatchObject({ reportStatus: 'pending', reportError: expect.any(String) })
})
it('retries report delivery without recomputing or posting again after success', async () => {
  const run = await completed()
  post.mockRejectedValueOnce(new Error('Temporary transport failure'))
  const object = coordinator(run.id)
  await object.alarm()
  await object.alarm()
  await object.alarm()
  expect(post).toHaveBeenCalledTimes(2)
  const { runDelivery } = await import('../../server/utils/agent-run-delivery')
  expect(await runDelivery(env, run.id)).toMatchObject({ taskStatus: 'complete', reportStatus: 'complete' })
  expect(db.prepare('SELECT model_calls FROM agent_runs WHERE id=?').get(run.id)?.model_calls).toBe(0)
})
it('preserves manual task edits and reassignment made after admission', async () => {
  const run = await completed()
  db.exec("UPDATE tasks SET title='Edited by human',status='done',updated_at='2999-01-01' WHERE id='assigned-task'")
  await coordinator(run.id).alarm()
  expect(db.prepare("SELECT status,result_summary FROM tasks WHERE id='assigned-task'").get()).toMatchObject({ status: 'done', result_summary: null })
  const { runDelivery } = await import('../../server/utils/agent-run-delivery')
  expect(await runDelivery(env, run.id)).toMatchObject({ taskStatus: 'skipped', reportStatus: 'complete' })
})
it('rechecks revoked authority for both task finalization and reporting', async () => {
  const run = await completed()
  db.exec("UPDATE roles SET permissions_bitmask=0 WHERE id='agent-role'")
  await coordinator(run.id).alarm()
  expect(post).not.toHaveBeenCalled()
  expect(db.prepare("SELECT status FROM tasks WHERE id='assigned-task'").get()?.status).toBe('ready')
  const { runDelivery } = await import('../../server/utils/agent-run-delivery')
  expect(await runDelivery(env, run.id)).toMatchObject({ taskStatus: 'blocked', reportStatus: 'blocked' })
})
it('rejects a missing report-channel permission before creating a paid attempt', async () => {
  db.prepare('UPDATE roles SET permissions_bitmask=? WHERE id=?').run(Permission.readTasks | Permission.executeTasks, 'agent-role')
  await expect(completed()).rejects.toMatchObject({ statusCode: 403, data: { error: { code: 'report_access' } } })
  expect(db.prepare('SELECT count(*) as count FROM agent_runs').get()?.count).toBe(0)
})

it('keeps Task identity and model output out of a shared conversation report', async () => {
  const run = await completed()
  await coordinator(run.id).alarm()
  const content = JSON.stringify(post.mock.calls)
  expect(content).not.toContain('Research')
  expect(content).not.toContain('/tasks?task=')
  expect(content).not.toContain('Verified result')
  expect(content).toContain('/runs/'+run.id)
})

async function editableRun() {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-24T12:00:00Z'))
  db.prepare('UPDATE roles SET permissions_bitmask=permissions_bitmask|? WHERE id=?').run(Permission.writeTasks, 'agent-role')
  const run = await completed()
  db.prepare("UPDATE agent_runs SET status='running' WHERE id=?").run(run.id)
  return run
}
async function editFromRun(id: string, patch: Parameters<typeof updateTask>[3]) {
  const auth = (await loadAuthorizationContext(env, { principalId: agentId, credential: { kind: 'agent_runtime', id }, delegatedBy: 'owner-user' }))!
  await updateTask(env, auth, 'assigned-task', patch, () => {})
}
async function finishRun(id: string) {
  db.prepare("UPDATE agent_runs SET status='completed' WHERE id=?").run(id)
  await coordinator(id).alarm()
}
it('finalizes a task after multiple edits made by its own Run', async () => {
  const run = await editableRun()
  vi.setSystemTime(new Date('2026-10-24T12:00:01Z'))
  await editFromRun(run.id, { description: 'Agent research' })
  vi.setSystemTime(new Date('2026-10-24T12:00:02Z'))
  await editFromRun(run.id, { title: 'Agent findings' })
  await finishRun(run.id)
  expect(db.prepare("SELECT title,description,status,result_summary FROM tasks WHERE id='assigned-task'").get())
    .toMatchObject({ title: 'Agent findings', description: 'Agent research', status: 'review', result_summary: 'Private result available to the initiating Member.' })
})
it.each(['before', 'between', 'after'])('preserves a human edit %s the Run edits', async position => {
  const run = await editableRun()
  let tick = 0
  const advance = () => vi.setSystemTime(new Date(Date.parse('2026-10-24T12:00:00Z') + ++tick * 1000))
  const human = async () => {
    advance()
    const auth = (await loadAuthorizationContext(env, { principalId: 'owner-user', credential: { kind: 'session' } }))!
    await updateTask(env, auth, 'assigned-task', { title: 'Human decision' }, () => {})
  }
  if (position === 'before') await human()
  advance()
  await editFromRun(run.id, { description: 'Agent research' })
  if (position === 'between') { await human(); advance(); await editFromRun(run.id, { description: 'More research' }) }
  if (position === 'after') await human()
  await finishRun(run.id)
  expect(db.prepare("SELECT title,status,result_summary FROM tasks WHERE id='assigned-task'").get())
    .toMatchObject({ title: 'Human decision', status: 'ready', result_summary: null })
})
it.each(['done', 'review'])('preserves an explicit %s decision from the Run itself', async status => {
  const run = await editableRun()
  vi.setSystemTime(new Date('2026-10-24T12:00:01Z'))
  await editFromRun(run.id, { status: status as 'done' | 'review' })
  await finishRun(run.id)
  expect(db.prepare("SELECT status,result_summary FROM tasks WHERE id='assigned-task'").get())
    .toMatchObject({ status, result_summary: null })
})
it('does not treat another Run from the same agent as its own edit', async () => {
  const run = await editableRun()
  const actor = (await loadAuthorizationContext(env, { principalId: 'owner-user', credential: { kind: 'session' } }))!
  const other = await createAgentRun(env, actor, { agentId, channelId: 'public-chat', taskId: 'assigned-task', prompt: 'Other work', idempotencyKey: 'other-request' })
  db.prepare("UPDATE agent_runs SET status='running' WHERE id=?").run(other.id)
  vi.setSystemTime(new Date('2026-10-24T12:00:01Z'))
  await editFromRun(other.id, { description: 'Another attempt' })
  vi.setSystemTime(new Date('2026-10-24T12:00:02Z'))
  await editFromRun(run.id, { title: 'Original attempt' })
  await finishRun(run.id)
  expect(db.prepare("SELECT status,result_summary FROM tasks WHERE id='assigned-task'").get())
    .toMatchObject({ status: 'ready', result_summary: null })
})
it.each(['archive', 'reassign'])('preserves a task %s after its own edit', async change => {
  const run = await editableRun()
  vi.setSystemTime(new Date('2026-10-24T12:00:01Z'))
  await editFromRun(run.id, { description: 'Agent research' })
  db.exec(change === 'archive'
    ? "UPDATE tasks SET archived_at='2026-10-24T12:00:02Z' WHERE id='assigned-task'"
    : "UPDATE tasks SET assignee_id='owner-user' WHERE id='assigned-task'")
  await finishRun(run.id)
  expect(db.prepare("SELECT status,result_summary FROM tasks WHERE id='assigned-task'").get())
    .toMatchObject({ status: 'ready', result_summary: null })
})
it('rejects an edit racing with the tool read without advancing the Run cursor', async () => {
  const run = await editableRun()
  vi.setSystemTime(new Date('2026-10-24T12:00:01Z'))
  const prepare = env.DB.prepare.bind(env.DB)
  vi.spyOn(env.DB, 'prepare').mockImplementation(query => {
    if (query.startsWith('update "tasks"')) db.exec("UPDATE tasks SET title='Concurrent human edit',updated_at='2026-10-24T12:00:02Z' WHERE id='assigned-task'")
    return prepare(query)
  })
  await expect(editFromRun(run.id, { description: 'Outdated write' })).rejects.toMatchObject({ statusCode: 409 })
  expect(db.prepare("SELECT title,description FROM tasks WHERE id='assigned-task'").get())
    .toMatchObject({ title: 'Concurrent human edit', description: '' })
  expect(db.prepare('SELECT task_edit_at FROM agent_runs WHERE id=?').get(run.id)?.task_edit_at).toBeNull()
})


it('expires a queued Run after a separate 24-hour wait with a distinct reason', async () => {
  const run = await completed()
  db.prepare("UPDATE agent_runs SET status='queued',result_text=NULL,created_at=?,deadline=? WHERE id=?").run('2026-10-22T00:00:00Z', '2026-10-22T00:15:00Z', run.id)
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-24T00:00:00Z'))
  await coordinator(run.id).alarm()
  expect(db.prepare('SELECT status,last_error,model_calls FROM agent_runs WHERE id=?').get(run.id)).toMatchObject({ status: 'failed', last_error: 'Run waited 24 hours for an execution slot. Start a new attempt.', model_calls: 0 })
})

it('retains an actionable inference denial if the executor subsequently reaches its deadline', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ok: true })))
  const run = await completed()
  db.prepare("UPDATE agent_runs SET status='running',result_text=NULL,last_error=?,deadline=? WHERE id=?").run('This agent cannot fit another request within its rolling 24-hour token budget.', '2026-10-22T00:15:00Z', run.id)
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-24T00:00:00Z'))
  await coordinator(run.id).alarm()
  expect(db.prepare('SELECT status,last_error FROM agent_runs WHERE id=?').get(run.id)).toMatchObject({ status: 'failed', last_error: expect.stringContaining('rolling 24-hour token budget') })
})
