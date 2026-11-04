import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { INIT_SQL } from '../../server/utils/db'
import { d1 } from '../helpers/sqlite-d1'
import type { L4Env } from '../../workers/env'
import { Permission } from '../../shared/permissions'

const serverId = '00000000-0000-4000-8000-000000000001'
const state = vi.hoisted(() => ({ env: null as L4Env | null, userId: 'author', param: 'm1', body: {} as Record<string, unknown> }))
const user = (id: string) => ({ id, kind: 'human' as const, displayName: id, avatarR2Key: null })
vi.mock('../../server/utils/guards', async () => {
  const { requireChannelAccessForMember, requireMemberForUser } = await import('../../server/utils/channel-access')
  const member = () => requireMemberForUser(state.env!, user(state.userId), serverId)
  return {
    requireChannelMember: (_event: unknown, channelId: string, flag?: number) => requireChannelAccessForMember(state.env!, member(), channelId, flag as never, 'POST'),
    requireChannelAccess: (_event: unknown, channelId: string) => requireChannelAccessForMember(state.env!, member(), channelId),
  }
})
vi.mock('../../server/utils/cf', async original => ({ ...await original<typeof import('../../server/utils/cf')>(), cf: () => ({ env: state.env!, waitUntil: () => {} }) }))

let sqlite: DatabaseSync
let fanout: ReturnType<typeof vi.fn>

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:'); sqlite.exec(INIT_SQL)
  sqlite.exec(`INSERT INTO server_identity(singleton,id) VALUES(1,'${serverId}');
    INSERT INTO roles(id,key,name,permissions_bitmask) VALUES('member','custom:member','Member',${Permission.sendMessages});
    INSERT INTO users(id,display_name,status,role_id,joined_at) VALUES('owner','Owner','active','member','2026-01-01'),('author','Author','active','member','2026-01-01');
    INSERT INTO server(id,name,owner_id) VALUES('${serverId}','Test','owner');
    INSERT INTO channels(id,name,type,visibility) VALUES('chat','Chat','text','server');
    INSERT INTO messages(id,channel_id,author_id,content,created_at,deleted_at) VALUES('m1','chat','author','hello','2026-01-01',NULL),
      ('gone','chat','author','','2026-01-01','2026-01-02');`)
  fanout = vi.fn(async () => {})
  state.env = { DB: d1(sqlite), CHANNEL_DO: { getByName: () => ({ fanout }) },
    RATE_LIMIT_DO: { getByName: () => ({ take: async () => true }) } } as unknown as L4Env
  state.userId = 'author'; state.param = 'm1'; state.body = { emoji: '👍' }
  vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
  vi.stubGlobal('getRouterParam', () => state.param)
  vi.stubGlobal('readBody', async () => state.body)
})
afterEach(() => { sqlite.close(); vi.unstubAllGlobals() })

const react = async () => (await import('../../server/api/messages/[id]/reactions.post')).default({} as never)
const edit = async () => (await import('../../server/api/messages/[id].patch')).default({} as never)
const reactions = () => sqlite.prepare('SELECT emoji FROM message_reactions').all().map(row => row.emoji)

describe('message reactions', () => {
  it.each(['👍', '❤️', '🏳️‍🌈', '👍🏽', '👨‍👩‍👧‍👦', '🇺🇦', '1️⃣', '🏴󠁧󠁢󠁥󠁮󠁧󠁿'])('accepts %s', async (emoji) => {
    state.body = { emoji }
    await expect(react()).resolves.toEqual({ op: 'add' })
    expect(reactions()).toEqual([emoji])
  })

  it.each(['lol', 'a👍', '👍 👍', '1', '👍👎', '<b>'])('refuses %j as a reaction', async (emoji) => {
    state.body = { emoji }
    await expect(react()).rejects.toMatchObject({ statusCode: 400 })
    expect(reactions()).toEqual([])
  })

  it('refuses reactions on deleted messages', async () => {
    state.param = 'gone'
    await expect(react()).rejects.toMatchObject({ statusCode: 409, data: { error: { code: 'deleted' } } })
    expect(reactions()).toEqual([])
  })

  it('toggles without failing on concurrent double clicks', async () => {
    const results = await Promise.all([react(), react(), react()])
    for (const result of results) expect(['add', 'remove']).toContain(result.op)
    expect(reactions().length).toBeLessThanOrEqual(1)
  })

  it('no-ops a racing insert instead of hitting the primary key', async () => {
    const db = state.env!.DB
    // The first request's insert lands between this request's delete and insert.
    state.env = { ...state.env!, DB: { ...db, prepare: (sql: string) => {
      if (/^insert into "message_reactions"/i.test(sql)) sqlite.exec(`INSERT OR IGNORE INTO message_reactions(message_id,user_id,emoji,created_at) VALUES('m1','author','👍','2026-01-01')`)
      return db.prepare(sql)
    } } as D1Database }
    await expect(react()).resolves.toEqual({ op: 'add' })
    expect(reactions()).toEqual(['👍'])
    expect(fanout).not.toHaveBeenCalled()
    state.env = { ...state.env!, DB: db }
    await expect(react()).resolves.toEqual({ op: 'remove' })
    expect(fanout).toHaveBeenCalledWith(expect.objectContaining({ op: 'remove', emoji: '👍' }))
  })
})

describe('message edits', () => {
  it('keeps my reaction highlight in the edit response but not in the broadcast', async () => {
    sqlite.exec(`INSERT INTO message_reactions(message_id,user_id,emoji,created_at) VALUES('m1','author','👍','2026-01-01')`)
    state.body = { content: 'edited' }
    const { message } = await edit()
    expect(message).toMatchObject({ content: 'edited', reactions: [{ emoji: '👍', count: 1, me: true }] })
    expect(fanout).toHaveBeenCalledWith({ t: 'message.update', message: expect.objectContaining({ reactions: [{ emoji: '👍', count: 1, me: false }] }) })
  })
})
