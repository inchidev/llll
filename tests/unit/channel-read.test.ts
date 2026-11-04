import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { INIT_SQL } from '../../server/utils/db'
import { d1 } from '../helpers/sqlite-d1'
import type { L4Env } from '../../workers/env'
import { Permission } from '../../shared/permissions'

const serverId = '00000000-0000-4000-8000-000000000001'
const state = vi.hoisted(() => ({ env: null as unknown as L4Env, userId: 'me', channelId: 'chat', pending: [] as Promise<unknown>[] }))
vi.mock('../../server/utils/guards', async () => {
  const { requireChannelAccessForMember, requireMemberForUser } = await import('../../server/utils/channel-access')
  const member = () => requireMemberForUser(state.env, { id: state.userId, kind: 'human', displayName: state.userId, avatarR2Key: null }, serverId)
  return { requireChannelAccess: (_event: unknown, channelId: string) => requireChannelAccessForMember(state.env, member(), channelId) }
})
vi.mock('../../server/utils/cf', async original => ({ ...await original<typeof import('../../server/utils/cf')>(), cf: () => ({ env: state.env, waitUntil: (p: Promise<unknown>) => state.pending.push(p) }) }))
vi.mock('../../workers/channel-activity', () => ({ signalChannelRead: vi.fn(async () => {}) }))

let sqlite: DatabaseSync
const cursor = (channelId: string) => (sqlite.prepare('SELECT last_read_message_id AS id FROM channel_reads WHERE channel_id=? AND user_id=?').get(channelId, 'me') as { id: string } | undefined)?.id
const markRead = async () => (await import('../../server/api/channels/[id]/read.post')).default({} as never)

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:'); sqlite.exec(INIT_SQL)
  sqlite.exec(`INSERT INTO server_identity(singleton,id) VALUES(1,'${serverId}');
    INSERT INTO roles(id,key,name,permissions_bitmask) VALUES('member','custom:member','Member',${Permission.sendMessages});
    INSERT INTO users(id,display_name,status,role_id,joined_at) VALUES('owner','Owner','active','member','2026-01-01'),('me','Me','active','member','2026-01-01');
    INSERT INTO server(id,name,owner_id) VALUES('${serverId}','Test','owner');
    INSERT INTO channels(id,name,type,visibility) VALUES('chat','general','text','server'),('secret','secret','text','private');
    INSERT INTO messages(id,channel_id,author_id,content,created_at) VALUES('m1','chat','owner','a','2026-01-01'),('m2','chat','owner','b','2026-01-02'),('s1','secret','owner','x','2026-01-01');
    INSERT INTO messages(id,channel_id,author_id,content,deleted_at,created_at) VALUES('m3','chat','owner','gone','2026-01-03','2026-01-03');
    INSERT INTO channels(id,name,type,visibility,parent_id,parent_message_id) VALUES('followed','followed','thread','server','chat','m1'),('unfollowed','unfollowed','thread','server','chat','m2');
    INSERT INTO messages(id,channel_id,author_id,content,created_at) VALUES('t1','followed','owner','r','2026-01-04'),('t2','followed','owner','r','2026-01-05'),('u1','unfollowed','owner','r','2026-01-04');
    INSERT INTO channel_reads(channel_id,user_id,last_read_message_id,updated_at) VALUES('followed','me','t1','2026-01-04');`)
  state.env = { DB: d1(sqlite) } as unknown as L4Env
  state.userId = 'me'; state.pending = []
  vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
  vi.stubGlobal('getRouterParam', () => state.channelId)
})
afterEach(async () => { await Promise.allSettled(state.pending); sqlite.close(); vi.unstubAllGlobals() })

it('marks a conversation and its followed threads read up to the latest surviving message', async () => {
  state.channelId = 'chat'
  await expect(markRead()).resolves.toMatchObject({ ok: true, channels: 2 })
  expect(cursor('chat')).toBe('m2')
  expect(cursor('followed')).toBe('t2')
  // Reading in place never follows a thread the member has not opened.
  expect(cursor('unfollowed')).toBeUndefined()
})

it('refuses conversations the member cannot read', async () => {
  state.channelId = 'secret'
  await expect(markRead()).rejects.toMatchObject({ statusCode: 404 })
  expect(cursor('secret')).toBeUndefined()
})
