import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { INIT_SQL } from '../../server/utils/db'
import { Permission } from '../../shared/permissions'
import { findPairDm } from '../../server/utils/dms'
import type { L4Env } from '../../workers/env'

const state = vi.hoisted(() => ({
  env: null as L4Env | null,
  actor: 'owner-001',
  id: 'pair-001',
  target: 'third-001',
  body: {} as Record<string, unknown>,
}))
vi.mock('../../server/utils/auth', () => ({ requireUser: async () => ({ id: state.actor, kind: 'human' }) }))
vi.mock('../../server/utils/cf', async (original) => ({
  ...await original<typeof import('../../server/utils/cf')>(),
  cf: () => ({ env: state.env!, waitUntil: () => {} }),
}))
vi.mock('../../server/utils/live', () => ({ revalidateLiveRooms: vi.fn(), liveRoom: vi.fn() }))

let sqlite: DatabaseSync
function d1(): D1Database {
  function prepare(sql: string) {
    let values: SQLInputValue[] = []
    const statement = {
      bind(...args: SQLInputValue[]) { values = args; return statement },
      async first() { return sqlite.prepare(sql).get(...values) ?? null },
      async all() { return { results: sqlite.prepare(sql).all(...values) } },
      async raw() { return sqlite.prepare(sql).all(...values).map(row => Object.values(row)) },
      async run() { return { success: true, meta: sqlite.prepare(sql).run(...values) } },
    }
    return statement
  }
  return { prepare, async batch(statements: { run: () => Promise<unknown> }[]) { return Promise.all(statements.map(s => s.run())) } } as unknown as D1Database
}

beforeAll(() => {
  vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
  vi.stubGlobal('getRouterParam', (_event: unknown, key: string) => key === 'userId' ? state.target : state.id)
  vi.stubGlobal('readBody', async () => state.body)
  vi.stubGlobal('createError', (input: { statusMessage: string }) => Object.assign(new Error(input.statusMessage), input))
})
afterAll(() => vi.unstubAllGlobals())
beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec(INIT_SQL)
  sqlite.exec(`
    INSERT INTO server_identity(singleton,id) VALUES(1,'10000000-0000-4000-8000-000000000001');
    INSERT INTO roles(id,key,name,permissions_bitmask) VALUES('member-role','member','Member',112);
    INSERT INTO users(id,kind,display_name,status,role_id,joined_at) VALUES
      ('owner-001','human','Owner','active','member-role','2026-01-01'),
      ('member-001','human','Member','active','member-role','2026-01-01'),
      ('third-001','human','Third','active','member-role','2026-01-01'),
      ('fourth-001','human','Fourth','active','member-role','2026-01-01'),
      ('agent-001','agent','Agent','active','member-role','2026-01-01');
    INSERT INTO server(id,name,owner_id) VALUES('10000000-0000-4000-8000-000000000001','Test','owner-001');
    INSERT INTO channels(id,name,type,visibility) VALUES('pair-001','dm','dm','private'),('group-001','dm','dm','private');
    UPDATE channels SET dm_kind = 'group', dm_owner_id = 'owner-001' WHERE id = 'group-001';
    INSERT INTO channel_members(channel_id,user_id,joined_at) VALUES
      ('pair-001','owner-001','2026-01-01'),('pair-001','member-001','2026-01-01'),
      ('group-001','owner-001','2026-01-01'),('group-001','member-001','2026-01-02'),('group-001','third-001','2026-01-03');
    INSERT INTO messages(id,channel_id,author_id,content,created_at) VALUES('secret-001','pair-001','owner-001','Private pair history','2026-01-01');
  `)
  state.env = { DB: d1(), CHANNEL_DO: { getByName: () => ({ fanout: async () => {} }) } } as unknown as L4Env
  state.actor = 'owner-001'
  state.id = 'pair-001'
  state.target = 'third-001'
  state.body = { userId: 'third-001' }
})
afterEach(() => sqlite.close())
const event = { path: '/api/dms/test/participants', method: 'POST' }

describe('DM privacy at HTTP handlers with real membership and database policy', () => {
  it('rejects adding a third member to an existing pair without exposing its history', async () => {
    const { default: add } = await import('../../server/api/dms/[id]/participants.post')
    await expect(add(event as never)).rejects.toMatchObject({ statusCode: 409 })
    expect(sqlite.prepare('SELECT count(*) AS n FROM channel_members WHERE channel_id = ?').get(state.id)).toMatchObject({ n: 2 })
  })
  it('rejects removal of another group member by an ordinary participant', async () => {
    state.actor = 'member-001'
    state.id = 'group-001'
    const { default: remove } = await import('../../server/api/dms/[id]/participants/[userId].delete')
    await expect(remove(event as never)).rejects.toMatchObject({ statusCode: 403 })
    expect(sqlite.prepare('SELECT count(*) AS n FROM channel_members WHERE channel_id = ?').get(state.id)).toMatchObject({ n: 3 })
  })
  it('rejects adding an Agent without Use agents', async () => {
    state.actor = 'member-001'
    state.id = 'group-001'
    state.body = { userId: 'agent-001' }
    const { default: add } = await import('../../server/api/dms/[id]/participants.post')
    await expect(add(event as never)).rejects.toMatchObject({ statusCode: 403 })
  })
  it('creates a separate group and keeps the original pair inaccessible to the new member', async () => {
    state.body = { userIds: ['member-001', 'third-001'] }
    const { default: create } = await import('../../server/api/dms/group.post')
    const { channel } = await create(event as never)
    expect(channel).toMatchObject({ dmKind: 'group', dmOwnerId: state.actor })
    expect(channel.id).not.toBe('pair-001')
    expect(sqlite.prepare('SELECT count(*) AS n FROM messages WHERE channel_id = ?').get(channel.id)).toMatchObject({ n: 0 })
    state.actor = 'third-001'
    const { requireChannelAccess } = await import('../../server/utils/guards')
    await expect(requireChannelAccess(event as never, 'pair-001')).rejects.toMatchObject({ statusCode: 404 })
    expect((await requireChannelAccess(event as never, channel.id)).participants).toHaveLength(3)
  })
  it('lets the group creator remove others, and revokes their conversation access', async () => {
    state.id = 'group-001'
    const { default: remove } = await import('../../server/api/dms/[id]/participants/[userId].delete')
    await expect(remove(event as never)).resolves.toEqual({ ok: true })
    state.actor = state.target
    const { requireChannelAccess } = await import('../../server/utils/guards')
    await expect(requireChannelAccess(event as never, state.id)).rejects.toMatchObject({ statusCode: 404 })
  })
  it("does not grant a Server owner removal power in someone else's group", async () => {
    state.id = 'group-001'
    sqlite.prepare("UPDATE channels SET dm_owner_id = 'member-001' WHERE id = ?").run(state.id)
    const { default: remove } = await import('../../server/api/dms/[id]/participants/[userId].delete')
    await expect(remove(event as never)).rejects.toMatchObject({ statusCode: 403 })
  })
  it('lets an ordinary member leave and preserves the group identity at two participants', async () => {
    state.id = 'group-001'
    state.actor = 'third-001'
    state.target = state.actor
    const { default: remove } = await import('../../server/api/dms/[id]/participants/[userId].delete')
    await expect(remove(event as never)).resolves.toEqual({ ok: true })
    expect(await findPairDm(state.env!, 'owner-001', 'member-001')).toBe('pair-001')
    state.actor = 'owner-001'
    state.body = { userId: 'fourth-001' }
    const { default: add } = await import('../../server/api/dms/[id]/participants.post')
    expect((await add(event as never)).channel.participants).toHaveLength(3)
  })
  it('never opens a two-member former group as a private pair', async () => {
    state.id = 'group-001'
    state.target = 'member-001'
    const { default: remove } = await import('../../server/api/dms/[id]/participants/[userId].delete')
    await remove(event as never)
    expect(await findPairDm(state.env!, 'owner-001', 'third-001')).toBeNull()
    state.body = { userId: 'third-001' }
    const { default: create } = await import('../../server/api/dms/index.post')
    const { channel } = await create(event as never)
    expect(channel.id).not.toBe(state.id)
    expect(channel.dmKind).toBe('pair')
  })
  it('clears creator authority when the creator leaves, even if invited back', async () => {
    state.id = 'group-001'
    state.target = state.actor
    const { default: remove } = await import('../../server/api/dms/[id]/participants/[userId].delete')
    await remove(event as never)
    state.actor = 'member-001'
    state.body = { userId: 'owner-001' }
    const { default: add } = await import('../../server/api/dms/[id]/participants.post')
    expect((await add(event as never)).channel.dmOwnerId).toBeNull()
    state.actor = 'owner-001'
    state.target = 'third-001'
    await expect(remove(event as never)).rejects.toMatchObject({ statusCode: 403 })
  })
  it('denies removing others from historical groups with no recorded creator', async () => {
    state.id = 'group-001'
    sqlite.prepare('UPDATE channels SET dm_owner_id = NULL WHERE id = ?').run(state.id)
    const { default: remove } = await import('../../server/api/dms/[id]/participants/[userId].delete')
    await expect(remove(event as never)).rejects.toMatchObject({ statusCode: 403 })
  })
  it('rejects creating an Agent pair without Use agents', async () => {
    state.actor = 'member-001'
    state.body = { userId: 'agent-001' }
    const { default: create } = await import('../../server/api/dms/index.post')
    await expect(create(event as never)).rejects.toMatchObject({ statusCode: 403 })
  })
  it('allows adding an Agent with the actual Role permission, outside DM send permissions', async () => {
    state.id = 'group-001'
    state.actor = 'member-001'
    state.body = { userId: 'agent-001' }
    sqlite.prepare('UPDATE roles SET permissions_bitmask = permissions_bitmask | ?').run(Permission.useAgents)
    const { default: add } = await import('../../server/api/dms/[id]/participants.post')
    expect((await add(event as never)).channel.participants?.some(member => member.kind === 'agent')).toBe(true)
  })
  it('rejects group creation with an Agent without Use agents', async () => {
    state.actor = 'member-001'
    state.body = { userIds: ['third-001', 'agent-001'] }
    const { default: create } = await import('../../server/api/dms/group.post')
    await expect(create(event as never)).rejects.toMatchObject({ statusCode: 403 })
  })
})

describe('DM privacy migration', () => {
  it('classifies existing groups without inventing a privileged creator', () => {
    const legacy = new DatabaseSync(':memory:')
    try {
      legacy.exec(`
        CREATE TABLE users(id TEXT PRIMARY KEY);
        CREATE TABLE channels(id TEXT PRIMARY KEY, type TEXT NOT NULL);
        CREATE TABLE channel_members(channel_id TEXT, user_id TEXT);
        INSERT INTO channels VALUES ('pair','dm'),('group','dm'),('text','text');
        INSERT INTO channel_members VALUES ('pair','a'),('pair','b'),('group','a'),('group','b'),('group','c');
      `)
      legacy.exec(readFileSync(new URL('../../drizzle/server-migrations/0011_dm_privacy.sql', import.meta.url), 'utf8'))
      expect(legacy.prepare("SELECT dm_kind, dm_owner_id FROM channels WHERE id = 'pair'").get()).toMatchObject({ dm_kind: 'pair', dm_owner_id: null })
      expect(legacy.prepare("SELECT dm_kind, dm_owner_id FROM channels WHERE id = 'group'").get()).toMatchObject({ dm_kind: 'group', dm_owner_id: null })
    } finally { legacy.close() }
  })
})
