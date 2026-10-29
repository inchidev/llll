import { DatabaseSync } from 'node:sqlite'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { INIT_SQL } from '../../server/utils/db'
import { d1 } from '../helpers/sqlite-d1'
import { ALL_PERMISSIONS, Permission } from '../../shared/permissions'
import type { L4Env } from '../../workers/env'

const state = vi.hoisted(() => ({ target: 'removed-agent', body: { status: 'active' }, query: {} as Record<string, unknown>, permissions: 0, isOwner: true }))
vi.mock('../../server/utils/guards', () => ({ requireMember: async () => ({ isOwner: state.isOwner, ownerId: 'owner', perms: state.permissions, user: { id: state.isOwner ? 'owner' : 'member' }, authorization: { serverId: '00000000-0000-4000-8000-000000000001', principal: { id: state.isOwner ? 'owner' : 'member', kind: 'human', roleId: 'owner-role', roleName: state.isOwner ? 'Owner' : 'Member', permissions: state.permissions, isOwner: state.isOwner }, credential: { kind: 'session' } } }) }))
let db: DatabaseSync, env: L4Env
const serverId = '00000000-0000-4000-8000-000000000001'
const getFile = vi.fn(), putFile = vi.fn(), deleteFile = vi.fn()
beforeAll(() => {
  vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
  vi.stubGlobal('getRouterParam', (_: unknown, key: string) => ['agentId', 'userId'].includes(key) ? state.target : serverId)
  vi.stubGlobal('getQuery', () => state.query)
  vi.stubGlobal('readBody', async () => state.body)
  vi.stubGlobal('readMultipartFormData', async () => [{ name: 'file', filename: 'avatar.png', data: Buffer.from('89504e470d0a1a0a00000000', 'hex') }])
  vi.stubGlobal('asRpc', (value: unknown) => value)
})
afterAll(() => vi.unstubAllGlobals())
beforeEach(() => {
  state.target = 'removed-agent'; state.query = {}; state.body = { status: 'active' }
  state.permissions = ALL_PERMISSIONS; state.isOwner = true
  vi.clearAllMocks()
  db = new DatabaseSync(':memory:'); db.exec(INIT_SQL)
  db.exec(`INSERT INTO server_identity(singleton,id) VALUES(1,'${serverId}');
    INSERT INTO roles(id,key,name,permissions_bitmask) VALUES('owner-role','owner','Owner',${ALL_PERMISSIONS});
    INSERT INTO users(id,kind,display_name,status,role_id,joined_at) VALUES
    ('owner','human','Owner','active','owner-role','2026-10-24'),
    ('active-agent','agent','Active','active','owner-role','2026-10-24'),
    ('paused-agent','agent','Paused','active','owner-role','2026-10-24'),
    ('removed-agent','agent','Removed','removed',NULL,NULL);
    INSERT INTO server(id,name,owner_id) VALUES('${serverId}','Fixture','owner');
    INSERT INTO agents(user_id,created_by,status,instructions) VALUES
    ('active-agent','owner','active','private agent prompt'),('paused-agent','owner','paused','private agent prompt'),('removed-agent','owner','paused','private agent prompt');`)
  env = { DB: d1(db), FILES: { get: getFile, put: putFile, delete: deleteFile }, SERVER_DO: { getByName: () => ({ notifyMembersChanged: async () => {}, snapshot: async () => [] }) } } as unknown as L4Env
})
afterEach(() => db.close())
function event() { return { context: { cloudflare: { env, context: { waitUntil: (p: Promise<unknown>) => { void p.catch(() => {}) } } } } } }
async function listAgents() { return (await import('../../server/api/servers/[id]/agents.get')).default(event() as never) }
async function taskAgents() { return (await import('../../server/api/servers/[id]/task-agents.get')).default(event() as never) }
it('excludes removed membership from both management listing modes and task assignees', async () => {
  expect((await listAgents()).agents.map(a => a.id)).toEqual(['active-agent', 'paused-agent'])
  state.query = { page: 1 }
  const page = await listAgents()
  expect(page.total).toBe(2)
  expect(page.agents.map(a => a.id)).toEqual(['active-agent', 'paused-agent'])
  expect((await taskAgents()).agents.map(a => a.id)).toEqual(['active-agent', 'paused-agent'])
  state.query = { page: 1, search: 'removed' }
  expect(await listAgents()).toEqual({ agents: [], total: 0 })
})
it('hides task assignees from members without agent visibility permission', async () => {
  state.isOwner = false
  state.permissions = Permission.readTasks
  expect(await taskAgents()).toEqual({ agents: [] })

  state.permissions |= Permission.useAgents
  expect((await taskAgents()).agents.map(a => a.id)).toEqual(['active-agent', 'paused-agent'])
})
it('publishes only agent status, without management instructions, in member profiles', async () => {
  const members = (await (await import('../../server/api/servers/[id]/members.get')).default(event() as never)).members
  expect(members.find(m => m.user.id === 'paused-agent')).toMatchObject({ agentStatus: 'paused' })
  expect(members.find(m => m.user.id === 'active-agent')).toMatchObject({ agentStatus: 'active' })
  expect(members.find(m => m.user.id === 'owner')).not.toHaveProperty('agentStatus')
  expect(JSON.stringify(members)).not.toContain('private agent prompt')
})
it('rejects reactivation after the real membership-removal handler runs', async () => {
  state.target = 'active-agent'
  await (await import('../../server/api/servers/[id]/members/[userId].delete')).default(event() as never)
  expect((await listAgents()).agents.map(a => a.id)).not.toContain(state.target)
  expect((await taskAgents()).agents.map(a => a.id)).not.toContain(state.target)
  await expect((await import('../../server/api/servers/[id]/agents/[agentId].patch')).default(event() as never)).rejects.toMatchObject({ statusCode: 404 })
  expect(db.prepare('SELECT status FROM agents WHERE user_id=?').get(state.target)?.status).toBe('paused')
})
it.each(['get', 'put', 'delete'])('rejects avatar %s for removed membership without touching storage', async method => {
  const handler = (await import(`../../server/api/servers/[id]/agents/[agentId]/avatar.${method}.ts`)).default
  await expect(handler(event())).rejects.toMatchObject({ statusCode: 404 })
  expect(getFile).not.toHaveBeenCalled(); expect(putFile).not.toHaveBeenCalled(); expect(deleteFile).not.toHaveBeenCalled()
})
