import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { INIT_SQL } from '../../server/utils/db'
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

describe('DMs have exactly two participants', () => {
  it.each(['add', 'remove', 'group'])('retires the %s group operation without changing membership or history', async operation => {
    const handler = operation === 'add'
      ? (await import('../../server/api/dms/[id]/participants.post')).default
      : operation === 'remove' ? (await import('../../server/api/dms/[id]/participants/[userId].delete')).default
      : (await import('../../server/api/dms/group.post')).default
    await expect(handler(event as never)).rejects.toMatchObject({ statusCode: 410 })
    expect(sqlite.prepare('SELECT count(*) AS n FROM channel_members WHERE channel_id=?').get('pair-001')).toMatchObject({ n: 2 })
    expect(sqlite.prepare('SELECT content FROM messages WHERE id=?').get('secret-001')?.content).toBe('Private pair history')
  })
  it('keeps pair history inaccessible to an unrelated member', async () => {
    state.actor = 'third-001'
    const { requireChannelAccess } = await import('../../server/utils/guards')
    await expect(requireChannelAccess(event as never, 'pair-001')).rejects.toMatchObject({ statusCode: 404 })
    expect(await findPairDm(state.env!, 'owner-001', 'member-001')).toBe('pair-001')
  })
  it('still requires Use agents to create a pair with an agent', async () => {
    state.actor = 'member-001'; state.body = { userId: 'agent-001' }
    const create = (await import('../../server/api/dms/index.post')).default
    await expect(create(event as never)).rejects.toMatchObject({ statusCode: 403 })
  })
})
