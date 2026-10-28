import { DatabaseSync } from 'node:sqlite'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { INIT_SQL } from '../../server/utils/db'
import { Permission } from '../../shared/permissions'
import type { L4Env } from '../../workers/env'
import { d1 } from '../helpers/sqlite-d1'
import { requireChannelAccess } from '../../server/utils/guards'

const state = vi.hoisted(() => ({ env: null as L4Env | null, actor: 'creator-001', id: 'general-001', body: {} as Record<string, unknown> }))
vi.mock('../../server/utils/auth', () => ({ requireUser: async () => ({ id: state.actor, kind: 'human' }) }))
vi.mock('../../server/utils/cf', async original => ({
  ...await original<typeof import('../../server/utils/cf')>(),
  cf: () => ({ env: state.env!, waitUntil: (promise: Promise<unknown>) => promise }),
}))

let sqlite: DatabaseSync
let accessChanged: ReturnType<typeof vi.fn>
let channelsChanged: ReturnType<typeof vi.fn>
let revalidate: ReturnType<typeof vi.fn>
beforeAll(() => {
  vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
  vi.stubGlobal('getRouterParam', () => state.id)
  vi.stubGlobal('readBody', async () => state.body)
})
afterAll(() => vi.unstubAllGlobals())
beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec(INIT_SQL)
  sqlite.exec(`
    INSERT INTO server_identity(singleton,id) VALUES(1,'00000000-0000-4000-8000-000000000001');
    INSERT INTO roles(id,key,name,permissions_bitmask) VALUES('admin-role','admin','Admin',${Permission.manageChannels | Permission.sendMessages}),('member-role','member','Member',${Permission.sendMessages});
    INSERT INTO users(id,kind,display_name,status,role_id,joined_at) VALUES
      ('creator-001','human','Creator','active','admin-role','2026-10-23'),
      ('admin-002','human','Admin','active','admin-role','2026-10-23'),
      ('member-001','human','Member','active','member-role','2026-10-23');
    INSERT INTO server(id,name,owner_id) VALUES('00000000-0000-4000-8000-000000000001','Order','admin-002');
    INSERT INTO channel_categories(id,name,position) VALUES('cat-0001','Work',1);
    INSERT INTO channels(id,name,type,visibility,position,created_by,created_at) VALUES
      ('general-001','general','text','server',1,'creator-001','2026-10-23'),
      ('random-001','random','text','server',2,'creator-001','2026-10-23'),
      ('ideas-001','ideas','text','server',3,'creator-001','2026-10-23');
    INSERT INTO messages(id,channel_id,author_id,content,created_at) VALUES('history-001','general-001','creator-001','Old news','2026-10-23');
    INSERT INTO channels(id,name,type,visibility,parent_id,parent_message_id) VALUES('thread-001','Thread','thread','server','general-001','history-001');
  `)
  accessChanged = vi.fn(async () => {})
  channelsChanged = vi.fn(async () => {})
  revalidate = vi.fn(async () => {})
  state.env = {
    DB: d1(sqlite),
    CHANNEL_DO: { getByName: (name: string) => ({ revalidateAccess: () => revalidate(name) }) },
    SERVER_DO: { getByName: () => ({ notifyChannelAccessChanged: accessChanged, notifyChannelsChanged: channelsChanged }) },
  } as unknown as L4Env
  state.actor = 'creator-001'
  state.id = 'general-001'
  state.body = {}
})
afterEach(() => sqlite.close())

const event = { method: 'PATCH', path: '/api/channels/general-001' }
const patch = async () => (await import('../../server/api/channels/[id].patch')).default(event as never)
const move = async () => (await import('../../server/api/channels/[id]/position.put')).default({ method: 'PUT', path: '/api/channels/x/position' } as never)
const order = () => sqlite.prepare("SELECT id, category_id AS categoryId FROM channels WHERE type='text' ORDER BY position").all().map(row => `${row.categoryId ?? '-'}:${row.id}`)

describe('changing channel visibility', () => {
  it('makes a server channel private for its creator and chosen members, revoking everyone else', async () => {
    state.body = { visibility: 'private', memberIds: ['member-001'] }
    await patch()
    expect(sqlite.prepare('SELECT visibility FROM channels WHERE id=?').get('general-001')).toMatchObject({ visibility: 'private' })
    expect(sqlite.prepare('SELECT user_id FROM channel_members WHERE channel_id=? ORDER BY user_id').all('general-001').map(row => row.user_id)).toEqual(['creator-001', 'member-001'])
    state.actor = 'admin-002'
    await expect(requireChannelAccess(event as never, 'general-001')).rejects.toMatchObject({ statusCode: 404 })
    await expect(requireChannelAccess(event as never, 'thread-001')).rejects.toMatchObject({ statusCode: 404 })
    expect(sqlite.prepare('SELECT visibility FROM channels WHERE id=?').get('thread-001')).toMatchObject({ visibility: 'private' })
    expect(revalidate).toHaveBeenCalledWith('channel:general-001')
    expect(revalidate).toHaveBeenCalledWith('channel:thread-001')
    expect(accessChanged).toHaveBeenCalledWith(expect.objectContaining({ channelId: 'general-001', revoked: false }), ['creator-001', 'member-001'])
    expect(accessChanged).toHaveBeenCalledWith(expect.objectContaining({ channelId: 'general-001', revoked: true }), ['admin-002'])
  })

  it('opens a private channel to the Server with its history treated as read', async () => {
    state.body = { visibility: 'private' }
    await patch()
    state.body = { visibility: 'server' }
    await patch()
    expect(sqlite.prepare('SELECT visibility FROM channels WHERE id=?').get('general-001')).toMatchObject({ visibility: 'server' })
    expect(sqlite.prepare('SELECT count(*) AS n FROM channel_members WHERE channel_id=?').get('general-001')).toMatchObject({ n: 0 })
    expect(sqlite.prepare('SELECT visibility FROM channels WHERE id=?').get('thread-001')).toMatchObject({ visibility: 'server' })
    expect(sqlite.prepare('SELECT last_read_message_id AS id FROM channel_reads WHERE channel_id=? AND user_id=?').get('general-001', 'member-001')).toMatchObject({ id: 'history-001' })
    expect(channelsChanged).toHaveBeenCalled()
  })

  it('lets only the channel creator change who can see it', async () => {
    state.actor = 'admin-002'
    state.body = { visibility: 'private' }
    await expect(patch()).rejects.toMatchObject({ statusCode: 403 })
    expect(sqlite.prepare('SELECT visibility FROM channels WHERE id=?').get('general-001')).toMatchObject({ visibility: 'server' })
  })
})

describe('reordering channels', () => {
  it('moves a channel before another and keeps a stable order', async () => {
    state.id = 'ideas-001'
    state.body = { categoryId: null, beforeId: 'general-001' }
    await move()
    expect(order()).toEqual(['-:ideas-001', '-:general-001', '-:random-001'])
    expect(sqlite.prepare("SELECT group_concat(position) AS p FROM (SELECT position FROM channels WHERE type='text' ORDER BY position)").get()).toMatchObject({ p: '1,2,3' })
    expect(channelsChanged).toHaveBeenCalledWith({ t: 'channels.changed', serverId: '00000000-0000-4000-8000-000000000001', deletedIds: [], parentIds: [] }, undefined)
  })

  it('moves a channel into a category, last by default', async () => {
    state.id = 'random-001'
    state.body = { categoryId: 'cat-0001', beforeId: null }
    await move()
    state.id = 'general-001'
    await move()
    expect(order()).toEqual(['-:ideas-001', 'cat-0001:random-001', 'cat-0001:general-001'])
    state.body = { categoryId: 'cat-0001', beforeId: 'random-001' }
    await move()
    expect(order()).toEqual(['-:ideas-001', 'cat-0001:general-001', 'cat-0001:random-001'])
  })

  it('rejects an anchor from another category', async () => {
    state.id = 'random-001'
    state.body = { categoryId: 'cat-0001', beforeId: 'general-001' }
    await expect(move()).rejects.toMatchObject({ statusCode: 400 })
  })

  it('appends new channels at the end', async () => {
    state.id = '00000000-0000-4000-8000-000000000001'
    state.body = { name: 'later', visibility: 'server' }
    const { channel } = await (await import('../../server/api/servers/[id]/channels.post')).default({ method: 'POST', path: '/api/servers/x/channels' } as never)
    expect(channel.position).toBe(4)
  })
})
