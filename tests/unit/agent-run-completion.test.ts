import { DatabaseSync } from 'node:sqlite'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { d1 } from '../helpers/sqlite-d1'
import { INIT_SQL } from '../../server/utils/db'
import { loadAuthorizationContext } from '../../server/utils/authorization'
import { createAgentRun } from '../../server/utils/agent-run-service'
import { AgentRunDurableObject } from '../../workers/agent-run-do'
import { Permission } from '../../shared/permissions'
import type { L4Env } from '../../workers/env'
vi.mock('cloudflare:workers', () => ({ DurableObject: class {
  constructor(protected ctx: unknown, protected env: unknown) {}
} }))
vi.mock('../../workers/agent-pi-durable', () => ({ runEmbeddedPi: vi.fn() }))
let db: DatabaseSync, env: L4Env
const post = vi.fn(async () => ({ id: 'result', channelId: 'public-chat' }))
const agentId = '00000000-0000-4000-8000-000000000002'
beforeEach(() => {
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
    AGENT_RUNNER_URL: 'http://runner', AGENT_RUNNER_TOKEN: 'fixture',
    CHANNEL_DO: { getByName: () => ({ postAgentMessage: post, fanout: async () => {} }) },
  } as unknown as L4Env
})
afterEach(() => db.close())
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
  expect(db.prepare("SELECT status,result_summary FROM tasks WHERE id='assigned-task'").get()).toMatchObject({ status: 'review', result_summary: 'Verified result' })
  expect(post).toHaveBeenCalledTimes(1)
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

it('includes task identity and a task link in the conversation report', async () => {
  const run = await completed()
  await coordinator(run.id).alarm()
  const content = JSON.stringify(post.mock.calls)
  expect(content).toContain('Research')
  expect(content).toContain('/tasks?task=')
  expect(content).toContain('Verified result')
})
