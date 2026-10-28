import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createError } from 'h3'
import { INIT_SQL } from '../../server/utils/db'
import { d1 } from '../helpers/sqlite-d1'
import { ALL_PERMISSIONS, Permission, hasPermission } from '../../shared/permissions'
import type { L4Env } from '../../workers/env'
const state = vi.hoisted(() => ({ target: 'target-user', body: {} as Record<string, unknown>, owner: false, perms: 0, access: { boards: ['allowed'] } as Record<string, string[]> }))
vi.mock('../../server/utils/guards', () => ({ requireMember: async (_: unknown, _id: string, permission: number) => {
  if (!state.owner && !hasPermission(state.perms, permission)) throw createError({ statusCode: 403 })
  return { isOwner: state.owner, ownerId: 'owner', user: { id: state.owner ? 'owner' : 'actor' }, perms: state.perms, authorization: { principal: { resourceAccess: state.access } } }
} }))
let db: DatabaseSync, env: L4Env
const notify = vi.fn(async () => {}), revalidate = vi.fn(async () => {})
const pending: Promise<unknown>[] = []
beforeEach(() => {
  state.target = 'target-user'; state.body = {}; state.owner = false
  state.perms = Permission.manageRoles | Permission.kick | Permission.sendMessages | Permission.attachFiles | Permission.startLive; state.access = { boards: ['allowed'] }
  notify.mockClear(); revalidate.mockClear(); pending.length = 0
  for (const [name, value] of Object.entries({ defineEventHandler: (fn: unknown) => fn, getRouterParam: (_: unknown, key: string) => key === 'id' ? '00000000-0000-4000-8000-000000000001' : state.target, readBody: async () => state.body, asRpc: (v: unknown) => v, createError })) vi.stubGlobal(name, value)
  db = new DatabaseSync(':memory:'); db.exec(INIT_SQL)
  db.exec(`INSERT INTO roles(id,key,name,permissions_bitmask,resource_access_json,is_system) VALUES
    ('owner-role','owner','Owner',${ALL_PERMISSIONS},'{}',1),('admin-role','admin','Admin',${ALL_PERMISSIONS},'{}',1),
    ('member-role','member','Member',${Permission.sendMessages},'{"boards":["allowed"]}',1),
    ('weak-role','custom:weak','Weak',${Permission.sendMessages},'{"boards":["allowed"]}',0),
    ('power-role','custom:power','Power',${Permission.sendMessages | Permission.executeTasks},'{"boards":["allowed"]}',0),
    ('wide-role','custom:wide','Wide',${Permission.sendMessages},'{"boards":["private"]}',0);
    INSERT INTO users(id,kind,display_name,status,role_id,joined_at) VALUES('owner','human','Owner','active','owner-role','2026-10-24'),('actor','human','Actor','active','weak-role','2026-10-24'),('target-user','human','Target','active','power-role','2026-10-24');
    INSERT INTO server_identity(singleton,id) VALUES(1,'00000000-0000-4000-8000-000000000001');
    INSERT INTO server(id,name,owner_id) VALUES('00000000-0000-4000-8000-000000000001','Fixture','owner');
    INSERT INTO channels(id,name,type,visibility,live_meeting_id) VALUES('live','Call','text','server','meeting');`)
  env = { DB: d1(db), SERVER_DO: { getByName: () => ({ notifyMembersChanged: notify }) }, CHANNEL_DO: { getByName: () => ({ revalidateLive: revalidate }) } } as unknown as L4Env
})
afterEach(async () => { await Promise.allSettled(pending); db.close(); vi.unstubAllGlobals() })
async function call(action: 'memberPatch'|'memberDelete'|'rolePatch'|'roleDelete') {
  const handlers = {
    memberPatch: () => import('../../server/api/servers/[id]/members/[userId].patch'),
    memberDelete: () => import('../../server/api/servers/[id]/members/[userId].delete'),
    rolePatch: () => import('../../server/api/servers/[id]/roles/[roleId].patch'),
    roleDelete: () => import('../../server/api/servers/[id]/roles/[roleId].delete'),
  }
  const handler = (await handlers[action]()).default
  const result = await handler({ context: { cloudflare: { env, context: { waitUntil: (p: Promise<unknown>) => pending.push(p) } } } } as never)
  await Promise.all(pending)
  return result
}
it.each(['memberPatch', 'memberDelete'] as const)('denies %s for a more powerful current member, including admins', async action => {
  state.body = { roleId: 'weak-role' }
  for (const role of ['power-role', 'wide-role', 'admin-role']) {
    db.prepare("UPDATE users SET role_id=? WHERE id='target-user'").run(role)
    await expect(call(action)).rejects.toMatchObject({ statusCode: 403 })
    expect(db.prepare("SELECT status,role_id FROM users WHERE id='target-user'").get()).toMatchObject({ status: 'active', role_id: role })
  }
  expect(notify).not.toHaveBeenCalled(); expect(revalidate).not.toHaveBeenCalled()
  expect(db.prepare('SELECT count(*) AS count FROM audit_log').get()).toMatchObject({ count: 0 })
})
it.each(['rolePatch', 'roleDelete'] as const)('denies %s of current permissions/resources even when replacing them with less', async action => {
  state.body = { name: 'Renamed' }
  for (const role of ['power-role', 'wide-role']) {
    state.target = role
    await expect(call(action)).rejects.toMatchObject({ statusCode: 403 })
    expect(db.prepare('SELECT id FROM roles WHERE id=?').get(role)).toBeTruthy()
  }
})
it.each(['memberPatch', 'memberDelete', 'rolePatch', 'roleDelete'] as const)('allows %s within scope and refreshes clients and Live access', async action => {
  db.exec("UPDATE users SET role_id='weak-role' WHERE id='target-user'")
  state.target = action.startsWith('role') ? 'weak-role' : 'target-user'
  state.body = action === 'memberPatch' ? { roleId: 'member-role' } : { name: 'Renamed' }
  await call(action)
  expect(notify).toHaveBeenCalledTimes(1); expect(revalidate).toHaveBeenCalledTimes(1)
})
it.each(['memberPatch', 'memberDelete', 'rolePatch', 'roleDelete'] as const)('preserves Owner authority for %s', async action => {
  state.owner = true; state.perms = ALL_PERMISSIONS; state.access = {}
  state.target = action.startsWith('role') ? 'power-role' : 'target-user'
  state.body = action === 'memberPatch' ? { roleId: 'weak-role' } : { name: 'Owner changed' }
  await expect(call(action)).resolves.toBeTruthy()
})
it('does not grant a wider fallback role while deleting a scoped role', async () => {
  state.target = 'weak-role'; db.exec("UPDATE roles SET resource_access_json='{}' WHERE key='member'")
  await expect(call('roleDelete')).rejects.toMatchObject({ statusCode: 403 })
})
it('rejects removed or missing targets without writing a kick audit', async () => {
  db.exec("UPDATE users SET status='removed',role_id=NULL,joined_at=NULL WHERE id='target-user'")
  await expect(call('memberDelete')).rejects.toMatchObject({ statusCode: 404 })
  state.target = 'missing'
  await expect(call('memberDelete')).rejects.toMatchObject({ statusCode: 404 })
  expect(db.prepare('SELECT count(*) AS count FROM audit_log').get()).toMatchObject({ count: 0 })
})
it('assigns reusable policies to a role and rejects permissions the manager does not have', async () => {
  state.target = 'weak-role'
  db.prepare('INSERT INTO project_policies(id,name,permissions_bitmask) VALUES (?,?,?)').run('chat-policy', 'Chat', Permission.sendMessages)
  state.body = { policyIds: ['chat-policy'] }
  const handler = (await import('../../server/api/servers/[id]/roles/[roleId]/policies/index.put')).default
  await handler({ context: { cloudflare: { env, context: { waitUntil: (p: Promise<unknown>) => pending.push(p) } } } } as never)
  expect(db.prepare('SELECT permissions_bitmask AS permissions FROM roles WHERE id=?').get('weak-role')).toMatchObject({ permissions: Permission.sendMessages })
  state.body = { policyIds: ['server-policy-owner'] }
  await expect(handler({ context: { cloudflare: { env, context: { waitUntil: (p: Promise<unknown>) => pending.push(p) } } } } as never)).rejects.toMatchObject({ statusCode: 403 })
  expect(db.prepare('SELECT policy_id FROM role_policies WHERE role_id=?').get('weak-role')).toMatchObject({ policy_id: 'chat-policy' })
})
