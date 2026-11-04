import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createError } from 'h3'
import { INIT_SQL } from '../../server/utils/db'
import { d1 } from '../helpers/sqlite-d1'
import { ALL_PERMISSIONS, Permission, hasPermission } from '../../shared/permissions'
import type { L4Env } from '../../workers/env'

const state = vi.hoisted(() => ({ body: {} as Record<string, unknown>, owner: false, perms: 0 }))
vi.mock('../../server/utils/guards', () => ({ requireMember: async (_: unknown, _id: string, permission: number) => {
  if (!state.owner && !hasPermission(state.perms, permission)) throw createError({ statusCode: 403 })
  return { isOwner: state.owner, ownerId: 'owner', user: { id: state.owner ? 'owner' : 'actor' }, perms: state.perms, authorization: { principal: { resourceAccess: { boards: ['allowed'] } } } }
} }))
let db: DatabaseSync, env: L4Env
const notify = vi.fn(async () => {}), revalidate = vi.fn(async () => {})
const pending: Promise<unknown>[] = []
beforeEach(() => {
  state.body = {}; state.owner = false
  state.perms = Permission.manageAgents | Permission.manageRoles | Permission.sendMessages
  notify.mockClear(); revalidate.mockClear(); pending.length = 0
  for (const [name, value] of Object.entries({ defineEventHandler: (fn: unknown) => fn, getRouterParam: (_: unknown, key: string) => key === 'id' ? '00000000-0000-4000-8000-000000000001' : 'target-agent', readBody: async () => state.body, asRpc: (v: unknown) => v, createError })) vi.stubGlobal(name, value)
  db = new DatabaseSync(':memory:'); db.exec(INIT_SQL)
  db.exec(`INSERT INTO roles(id,key,name,permissions_bitmask,resource_access_json,is_system) VALUES
    ('owner-role','owner','Owner',${ALL_PERMISSIONS},'{}',1),
    ('admin-role','admin','Admin',${ALL_PERMISSIONS},'{}',1),
    ('weak-role','custom:weak','Weak',${Permission.sendMessages},'{"boards":["allowed"]}',0),
    ('peer-role','custom:peer','Peer',${Permission.sendMessages},'{"boards":["allowed"]}',0),
    ('power-role','custom:power','Power',${Permission.sendMessages | Permission.executeTasks},'{"boards":["allowed"]}',0),
    ('wide-role','custom:wide','Wide',${Permission.sendMessages},'{"boards":["private"]}',0);
    INSERT INTO users(id,kind,display_name,status,role_id,joined_at) VALUES
    ('owner','human','Owner','active','owner-role','2026-10-25'),
    ('actor','human','Actor','active','weak-role','2026-10-25'),
    ('target-agent','agent','Helper','active','weak-role','2026-10-25');
    INSERT INTO agents(user_id,harness,model,instructions,status,created_by) VALUES('target-agent','pi','fixture','Before','active','owner');
    INSERT INTO server_identity(singleton,id) VALUES(1,'00000000-0000-4000-8000-000000000001');
    INSERT INTO server(id,name,owner_id) VALUES('00000000-0000-4000-8000-000000000001','Fixture','owner');
    INSERT INTO channels(id,name,type,visibility,live_meeting_id) VALUES('live','Call','text','server','meeting');`)
  env = { DB: d1(db), SERVER_DO: { getByName: () => ({ notifyMembersChanged: notify }) }, CHANNEL_DO: { getByName: () => ({ revalidateLive: revalidate }) } } as unknown as L4Env
})
afterEach(async () => { await Promise.allSettled(pending); db.close(); vi.unstubAllGlobals() })
async function call() {
  const handler = (await import('../../server/api/servers/[id]/agents/[agentId].patch')).default
  const result = await handler({ context: { cloudflare: { env, context: { waitUntil: (p: Promise<unknown>) => pending.push(p) } } } } as never)
  await Promise.all(pending)
  return result
}
it('saves the role with the profile, audits it and refreshes membership and live access', async () => {
  state.body = { roleId: 'peer-role', displayName: 'Updated', instructions: 'After', status: 'paused' }
  const result = await call()
  expect(result.agent).toMatchObject({ roleId: 'peer-role', displayName: 'Updated', instructions: 'After', status: 'paused' })
  expect(db.prepare("SELECT role_id,display_name FROM users WHERE id='target-agent'").get()).toMatchObject({ role_id: 'peer-role', display_name: 'Updated' })
  const row = db.prepare("SELECT meta_json FROM audit_log WHERE action='agent.update'").get() as { meta_json: string }
  expect(JSON.parse(row.meta_json)).toMatchObject({ roleChanged: true, previousRoleId: 'weak-role', roleId: 'peer-role' })
  expect(notify).toHaveBeenCalledTimes(1); expect(revalidate).toHaveBeenCalledTimes(1)
})
it('requires Manage roles and leaves both profile and role untouched on rejection', async () => {
  state.perms = Permission.manageAgents | Permission.sendMessages
  state.body = { roleId: 'peer-role', displayName: 'Denied', instructions: 'Denied' }
  await expect(call()).rejects.toMatchObject({ statusCode: 403 })
  expect(db.prepare("SELECT role_id,display_name FROM users WHERE id='target-agent'").get()).toMatchObject({ role_id: 'weak-role', display_name: 'Helper' })
  expect(db.prepare("SELECT instructions FROM agents WHERE user_id='target-agent'").get()).toMatchObject({ instructions: 'Before' })
  expect(notify).not.toHaveBeenCalled(); expect(revalidate).not.toHaveBeenCalled()
})
it.each(['power-role', 'wide-role', 'admin-role'])('protects a stronger or wider current role before a downgrade from %s', async role => {
  db.prepare("UPDATE users SET role_id=? WHERE id='target-agent'").run(role)
  state.body = { roleId: 'weak-role', displayName: 'Denied' }
  await expect(call()).rejects.toMatchObject({ statusCode: 403 })
  expect(db.prepare("SELECT role_id,display_name FROM users WHERE id='target-agent'").get()).toMatchObject({ role_id: role, display_name: 'Helper' })
})
it.each(['power-role', 'wide-role', 'admin-role', 'owner-role'])('rejects assigning a forbidden replacement %s', async role => {
  state.body = { roleId: role }
  await expect(call()).rejects.toMatchObject({ statusCode: 403 })
})
it('allows the Owner to move an Admin agent to a task role', async () => {
  state.owner = true; state.perms = ALL_PERMISSIONS
  db.exec("UPDATE users SET role_id='admin-role' WHERE id='target-agent'")
  state.body = { roleId: 'power-role' }
  await expect(call()).resolves.toMatchObject({ agent: { roleId: 'power-role' } })
})
it('never allows the Owner role to be assigned to an agent', async () => {
  state.owner = true; state.perms = ALL_PERMISSIONS; state.body = { roleId: 'owner-role' }
  await expect(call()).rejects.toMatchObject({ statusCode: 403 })
})
it('continues to allow profile-only editing without role-management permission', async () => {
  state.perms = Permission.manageAgents | Permission.sendMessages; state.body = { displayName: 'Renamed' }
  await expect(call()).resolves.toMatchObject({ agent: { roleId: 'weak-role', displayName: 'Renamed' } })
  expect(revalidate).not.toHaveBeenCalled()
})
it.each(['power-role', 'wide-role', 'admin-role'])('refuses profile edits of an Agent whose %s exceeds the editor', async role => {
  state.perms = Permission.manageAgents | Permission.sendMessages
  db.prepare("UPDATE users SET role_id=? WHERE id='target-agent'").run(role)
  state.body = { instructions: 'Planted instructions' }
  await expect(call()).rejects.toMatchObject({ statusCode: 403 })
  expect(db.prepare("SELECT instructions FROM agents WHERE user_id='target-agent'").get()).toMatchObject({ instructions: 'Before' })
})
it('refuses a name another Member already uses, ignoring case', async () => {
  state.body = { displayName: ' owner ' }
  await expect(call()).rejects.toMatchObject({ statusCode: 409 })
  state.body = { displayName: 'Helper' }
  await expect(call()).resolves.toMatchObject({ agent: { displayName: 'Helper' } })
})
it('rejects missing roles and removed agents', async () => {
  state.body = { roleId: 'missing-role' }
  await expect(call()).rejects.toMatchObject({ statusCode: 404 })
  db.exec("UPDATE users SET status='removed' WHERE id='target-agent'")
  state.body = { roleId: 'peer-role' }
  await expect(call()).rejects.toMatchObject({ statusCode: 404 })
})
