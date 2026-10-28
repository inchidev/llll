import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createError } from 'h3'
import { INIT_SQL } from '../../server/utils/db'
import { d1 } from '../helpers/sqlite-d1'
import { ALL_PERMISSIONS, Permission, hasPermission } from '../../shared/permissions'
import type { L4Env } from '../../workers/env'

const state = vi.hoisted(() => ({ owner: false, perms: 0 }))
vi.mock('../../server/utils/guards', () => ({ requireMember: async (_: unknown, _id: string, permission: number) => {
  if (!state.owner && !hasPermission(state.perms, permission)) throw createError({ statusCode: 403 })
  return { isOwner: state.owner, ownerId: 'owner', user: { id: state.owner ? 'owner' : 'actor' }, perms: state.perms, authorization: { principal: { resourceAccess: { boards: ['allowed'] } } } }
} }))
let db: DatabaseSync, env: L4Env
const cancel = vi.fn(async (id: string) => { db.prepare("UPDATE agent_runs SET status='cancelled' WHERE id=?").run(id) })
const deleteFile = vi.fn(async () => {})
const pending: Promise<unknown>[] = []
beforeEach(() => {
  state.owner = false
  state.perms = Permission.manageAgents | Permission.sendMessages
  cancel.mockClear(); deleteFile.mockClear(); pending.length = 0
  for (const [name, value] of Object.entries({ defineEventHandler: (fn: unknown) => fn, getRouterParam: (_: unknown, key: string) => key === 'id' ? '00000000-0000-4000-8000-000000000001' : 'target-agent', asRpc: (v: unknown) => v, createError })) vi.stubGlobal(name, value)
  db = new DatabaseSync(':memory:'); db.exec(INIT_SQL)
  db.exec(`INSERT INTO roles(id,key,name,permissions_bitmask,resource_access_json,is_system) VALUES
    ('owner-role','owner','Owner',${ALL_PERMISSIONS},'{}',1),
    ('weak-role','custom:weak','Weak',${Permission.sendMessages},'{"boards":["allowed"]}',0),
    ('power-role','custom:power','Power',${Permission.sendMessages | Permission.executeTasks},'{"boards":["allowed"]}',0);
    INSERT INTO users(id,kind,display_name,status,role_id,avatar_r2_key,joined_at) VALUES
    ('owner','human','Owner','active','owner-role',NULL,'2026-10-25'),
    ('actor','human','Actor','active','weak-role',NULL,'2026-10-25'),
    ('target-agent','agent','Helper','active','weak-role','avatars/helper.png','2026-10-25'),
    ('other-agent','agent','Other','active','weak-role',NULL,'2026-10-25');
    INSERT INTO agents(user_id,harness,model,instructions,status,created_by) VALUES('target-agent','pi','fixture','','active','owner'),('other-agent','pi','fixture','','active','owner');
    INSERT INTO server_identity(singleton,id) VALUES(1,'00000000-0000-4000-8000-000000000001');
    INSERT INTO server(id,name,owner_id) VALUES('00000000-0000-4000-8000-000000000001','Fixture','owner');
    INSERT INTO channels(id,name,type,visibility) VALUES('general','general','text','server'),('dm','dm','dm','private');
    INSERT INTO channel_members(channel_id,user_id,joined_at) VALUES('dm','owner','2026-10-25'),('dm','target-agent','2026-10-25');
    INSERT INTO messages(id,channel_id,author_id,content,created_at) VALUES('agent-message','dm','target-agent','Hello','2026-10-25');
    INSERT INTO task_boards(id,name,created_by) VALUES('board','Work','owner');
    INSERT INTO tasks(id,board_id,title,status,assignee_id,created_by) VALUES
      ('ready-task','board','Ready','ready','target-agent','owner'),
      ('review-task','board','Review','review','target-agent','owner'),
      ('done-task','board','Done','done','target-agent','owner'),
      ('other-task','board','Other','ready','other-agent','owner');
    INSERT INTO agent_sessions(id,agent_id,channel_id,created_at,updated_at) VALUES('session','target-agent','dm','2026-10-25','2026-10-25');
    INSERT INTO agent_runs(id,session_id,agent_id,channel_id,initiated_by,idempotency_key,status,prompt,model,instructions,mandate_json,deadline,created_at,updated_at) VALUES
      ('running','session','target-agent','dm','owner','k1','running','p','m','i','{}','2026-10-26','2026-10-25','2026-10-25'),
      ('finished','session','target-agent','dm','owner','k2','completed','p','m','i','{}','2026-10-26','2026-10-25','2026-10-25');
    INSERT INTO agent_schedules(id,principal_id,created_by,channel_id,kind,content,agent_id,first_at,timezone,recurrence,next_at,status,authorization_json,created_at) VALUES
      ('schedule','owner','owner','general','work','Do it','target-agent','2026-10-26','UTC','daily','2026-10-26','active','{}','2026-10-25');
    INSERT INTO mcp_access_tokens(id,name,token_hash,token_prefix,scopes_json,subject_id,created_by) VALUES('token','Agent token','hash','prefix','[]','target-agent','owner');`)
  env = { DB: d1(db), FILES: { delete: deleteFile }, AGENT_RUN_DO: { getByName: (name: string) => ({ cancel: () => cancel(name.slice(4)) }) },
    SERVER_DO: { getByName: () => ({ notifyMembersChanged: async () => {}, notifyTasksChanged: async () => {} }) }, CHANNEL_DO: { getByName: () => ({ revalidateLive: async () => {} }) } } as unknown as L4Env
})
afterEach(async () => { await Promise.allSettled(pending); db.close(); vi.unstubAllGlobals() })
async function call() {
  const handler = (await import('../../server/api/servers/[id]/agents/[agentId].delete')).default
  const result = await handler({ context: { cloudflare: { env, context: { waitUntil: (p: Promise<unknown>) => pending.push(p.catch(() => {})) } } } } as never)
  await Promise.all(pending)
  return result
}

it('removes the agent for new work, stops its work and keeps its history', async () => {
  await expect(call()).resolves.toMatchObject({ ok: true, cancelledRuns: 1, unassignedTasks: 2 })
  expect(db.prepare("SELECT status,role_id,avatar_r2_key FROM users WHERE id='target-agent'").get()).toMatchObject({ status: 'removed', role_id: null, avatar_r2_key: null })
  expect(db.prepare("SELECT status,archived_by FROM agents WHERE user_id='target-agent'").get()).toMatchObject({ status: 'paused', archived_by: 'actor' })
  expect(cancel).toHaveBeenCalledTimes(1)
  expect(db.prepare("SELECT id,status FROM agent_runs ORDER BY id").all()).toEqual([{ id: 'finished', status: 'completed' }, { id: 'running', status: 'cancelled' }])
  expect(db.prepare("SELECT status,next_at FROM agent_schedules WHERE id='schedule'").get()).toMatchObject({ status: 'cancelled', next_at: null })
  expect(db.prepare("SELECT revoked_at FROM mcp_access_tokens WHERE id='token'").get()).not.toMatchObject({ revoked_at: null })
  expect(db.prepare('SELECT id,status,assignee_id FROM tasks ORDER BY id').all()).toEqual([
    { id: 'done-task', status: 'done', assignee_id: 'target-agent' },
    { id: 'other-task', status: 'ready', assignee_id: 'other-agent' },
    { id: 'ready-task', status: 'backlog', assignee_id: null },
    { id: 'review-task', status: 'review', assignee_id: null },
  ])
  // Messages and DM membership stay; the DM becomes read-only through the existing removed-member rule.
  expect(db.prepare("SELECT content FROM messages WHERE id='agent-message'").get()).toMatchObject({ content: 'Hello' })
  expect(db.prepare("SELECT count(*) AS n FROM channel_members WHERE channel_id='dm'").get()).toMatchObject({ n: 2 })
  expect(deleteFile).toHaveBeenCalledWith('avatars/helper.png')
  const audit = db.prepare("SELECT meta_json FROM audit_log WHERE action='agent.delete'").get() as { meta_json: string }
  expect(JSON.parse(audit.meta_json)).toMatchObject({ displayName: 'Helper', cancelledRuns: 1, cancelledSchedules: 1, revokedConnections: 1, unassignedTasks: 2 })
  // A deleted agent is gone for good: a second delete finds nothing.
  await expect(call()).rejects.toMatchObject({ statusCode: 404 })
})

it('requires Manage agents', async () => {
  state.perms = Permission.sendMessages
  await expect(call()).rejects.toMatchObject({ statusCode: 403 })
  expect(db.prepare("SELECT status FROM users WHERE id='target-agent'").get()).toMatchObject({ status: 'active' })
})

it('protects an agent whose role is stronger than the manager', async () => {
  db.exec("UPDATE users SET role_id='power-role' WHERE id='target-agent'")
  await expect(call()).rejects.toMatchObject({ statusCode: 403 })
  expect(db.prepare("SELECT status FROM users WHERE id='target-agent'").get()).toMatchObject({ status: 'active' })
  expect(cancel).not.toHaveBeenCalled()
  state.owner = true; state.perms = ALL_PERMISSIONS
  await expect(call()).resolves.toMatchObject({ ok: true })
})

it('frees the name for a new agent', async () => {
  await call()
  const { assertAgentNameAvailable } = await import('../../server/utils/member-names')
  await expect(assertAgentNameAvailable(env, 'Helper')).resolves.toBeUndefined()
})
