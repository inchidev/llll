import { DatabaseSync } from 'node:sqlite'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { d1 } from '../helpers/sqlite-d1'
import { INIT_SQL } from '../../server/utils/db'
import { loadAuthorizationContext } from '../../server/utils/authorization'
import { createAgentRun, findAgentRun, runAuthorization, runCapability, verifyRunCapability } from '../../server/utils/agent-run-service'
import { agentGateway } from '../../server/utils/agent-gateway'
import { agentTools } from '../../server/utils/agent-tools'
import { Permission } from '../../shared/permissions'
import type { L4Env } from '../../workers/env'

const serverId = '00000000-0000-4000-8000-000000000001'
const agentId = '00000000-0000-4000-8000-000000000002'
let db: DatabaseSync
let env: L4Env
const wake = vi.fn()
const start = () => loadAuthorizationContext(env, { principalId: 'owner-user', credential: { kind: 'session' } })
const input = () => ({ agentId, channelId: 'public-chat', prompt: 'Research the market', idempotencyKey: 'request-0001' })

beforeEach(() => {
  wake.mockReset()
  db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys=ON')
  db.exec(INIT_SQL)
  db.exec(`INSERT INTO server_identity(singleton,id) VALUES(1,'${serverId}');
    INSERT INTO roles(id,key,name,permissions_bitmask,resource_access_json) VALUES
      ('owner-role','owner','Owner',0,'{}'),
      ('agent-role','custom:agent','Researcher',${Permission.sendMessages | Permission.readTasks},'{"boards":["board-allowed"]}');
    INSERT INTO users(id,kind,display_name,status,role_id,joined_at) VALUES
      ('owner-user','human','Owner','active','owner-role','2026-10-21'),
      ('${agentId}','agent','Researcher','active','agent-role','2026-10-21');
    INSERT INTO server(id,name,owner_id) VALUES('${serverId}','L4','owner-user');
    INSERT INTO agents(user_id,created_by,harness) VALUES('${agentId}','owner-user','pi');
    INSERT INTO channels(id,name,type,visibility) VALUES('public-chat','Research','text','server');
    INSERT INTO task_boards(id,name,created_by) VALUES('board-allowed','Allowed','owner-user'),('board-private','Private','owner-user');`)
  env = { DB: d1(db), AUTH_SECRET: 'test-server-secret-with-32-characters', FILES: {},
    AGENT_RUN_DO: { getByName: () => ({ wake }) }, AGENT_RUNNER_URL: 'http://runner', AGENT_RUNNER_TOKEN: 'runner-secret' } as unknown as L4Env
})
afterEach(() => db.close())

describe('Pi run authorization', () => {
  it('recovers a persisted admission when the first wake fails, without creating another attempt', async () => {
    wake.mockRejectedValueOnce(new Error('Coordinator unavailable'))
    await expect(createAgentRun(env, (await start())!, input())).rejects.toThrow('Coordinator unavailable')
    const retry = await createAgentRun(env, (await start())!, input())
    expect(retry.status).toBe('queued')
    expect(db.prepare('SELECT count(*) as count FROM agent_runs').get()).toMatchObject({ count: 1 })
    expect(wake).toHaveBeenCalledTimes(2)
  })
  it('rejects concurrent reuse of a request identity for different work', async () => {
    const actor = (await start())!
    const results = await Promise.allSettled([createAgentRun(env, actor, input()), createAgentRun(env, actor, { ...input(), prompt: 'Different work' })])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.find(result => result.status === 'rejected')
    expect(rejected).toMatchObject({ status: 'rejected', reason: { statusCode: 409 } })
    expect(db.prepare('SELECT count(*) as count FROM agent_runs').get()).toMatchObject({ count: 1 })
  })
  it('creates one durable attempt for duplicate admission and retains role ceilings under owner invocation', async () => {
    const first = await createAgentRun(env, (await start())!, input())
    const second = await createAgentRun(env, (await start())!, input())
    expect(second.id).toBe(first.id)
    expect(wake).toHaveBeenCalledTimes(2)
    const authorization = await runAuthorization(env, first)
    expect(authorization.principal.permissions & Permission.writeTasks).toBe(0)
    expect(authorization.principal.resourceAccess?.boards).toEqual(['board-allowed'])
  })

  it('rejects capability replay against another run and rejects tools before execution starts', async () => {
    const run = await createAgentRun(env, (await start())!, input())
    const token = await runCapability(env, run.id)
    expect(await verifyRunCapability(env, run.id, token)).toBe(true)
    expect(await verifyRunCapability(env, 'another-run', token)).toBe(false)
    const response = await agentGateway(new Request('http://server/tools', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: '{}' }), env, run.id, 'tools', () => {})
    expect(response.status).toBe(403)
  })

  it('filters tools through current role and resources, including after role revocation', async () => {
    const run = await createAgentRun(env, (await start())!, input())
    db.prepare("UPDATE agent_runs SET status='running' WHERE id=?").run(run.id)
    const token = await runCapability(env, run.id)
    const call = (callId: string, name: string, args: unknown = {}) => agentGateway(new Request('http://server/tools', {
      method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify({ callId, name, arguments: args }),
    }), env, run.id, 'tools', () => {})
    const first = await call('call-1', 'list_tasks')
    expect(first.status).toBe(200)
    expect(await first.json()).toMatchObject({ boards: [{ id: 'board-allowed' }] })
    const denied = await call('call-2', 'create_task', { boardId: 'board-allowed', title: 'Unauthorized write' })
    expect(denied.status).toBe(403)
    db.exec(`UPDATE roles SET permissions_bitmask=${Permission.sendMessages} WHERE id='agent-role'`)
    expect((await call('call-3', 'list_tasks')).status).toBe(403)
    expect((await call('call-1', 'list_tasks')).status).toBe(403)
    expect((await findAgentRun(env, run.id))?.status).toBe('running')
  })

  it('does not replay a tool whose outcome is uncertain', async () => {
    const run = await createAgentRun(env, (await start())!, input())
    db.prepare("UPDATE agent_runs SET status='running' WHERE id=?").run(run.id)
    db.prepare("INSERT INTO agent_run_tools(run_id,call_id,name,arguments_json,status,created_at) VALUES(?,?,?,'{}','pending','2026-10-21')").run(run.id,'uncertain','list_tasks')
    const response = await agentGateway(new Request('http://server/tools', { method: 'POST', headers: { Authorization: `Bearer ${await runCapability(env, run.id)}` },
      body: JSON.stringify({ callId: 'uncertain', name: 'list_tasks', arguments: {} }) }), env, run.id, 'tools', () => {})
    expect(response.status).toBe(409)
  })

  it('keeps an autonomous subtask inside the original resource and computer ceiling', async () => {
    db.prepare("UPDATE roles SET permissions_bitmask=? WHERE id='agent-role'").run(Permission.sendMessages | Permission.readTasks | Permission.executeTasks | Permission.useComputer)
    db.prepare("INSERT INTO tasks(id,board_id,title,description,status,priority,position,assignee_id,created_by,created_at,updated_at) VALUES('child-task','board-allowed','Research one source','','ready','normal',1,?,'owner-user','2026-10-21','2026-10-21')").run(agentId)
    const parent = await createAgentRun(env, (await start())!, input())
    const tools = agentTools(env, await runAuthorization(env, parent), () => {}, parent)
    const result = await tools.call('execute_task', { taskId: 'child-task' }) as { runId: string }
    const child = (await findAgentRun(env, result.runId))!
    expect(JSON.parse(child.mandateJson)).toMatchObject({ depth: 1, computer: false, agentResourceAccess: { boards: ['board-allowed'] } })
    const exhausted = { ...child, mandateJson: JSON.stringify({ ...JSON.parse(child.mandateJson), depth: 2 }) }
    await expect(agentTools(env, await runAuthorization(env, exhausted), () => {}, exhausted).call('execute_task', { taskId: 'child-task' })).rejects.toMatchObject({ statusCode: 409 })
  })
})
