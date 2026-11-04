import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { INIT_SQL } from '../../server/utils/db'
import { d1 } from '../helpers/sqlite-d1'
import type { L4Env } from '../../workers/env'
import { Permission } from '../../shared/permissions'
import { advanceChatRead, chatAttention } from '../../workers/chat-attention'
import { channelUnreadCount } from '../../workers/unread'
import { chatAlertRecipients, chatPushStillWanted } from '../../workers/chat-alerts'

const serverId = '00000000-0000-4000-8000-000000000001'
const state = vi.hoisted(() => ({ env: null as unknown as L4Env, userId: 'me', channelId: 'thread', body: {} as object }))
vi.mock('../../server/utils/guards', async () => {
  const { requireChannelAccessForMember, requireMemberForUser } = await import('../../server/utils/channel-access')
  const member = () => requireMemberForUser(state.env, { id: state.userId, kind: 'human', displayName: state.userId, avatarR2Key: null }, serverId)
  return {
    requireChannelAccess: (_event: unknown, id: string) => requireChannelAccessForMember(state.env, member(), id),
    requireMember: member,
  }
})
vi.mock('../../server/utils/cf', async original => ({ ...await original<typeof import('../../server/utils/cf')>(), cf: () => ({ env: state.env, waitUntil: () => {} }) }))
vi.mock('../../workers/channel-activity', () => ({ signalChatAttention: vi.fn(async () => {}) }))

let sqlite: DatabaseSync
const patch = async (body: object) => { state.body = body; return (await import('../../server/api/channels/[id]/attention.patch')).default({} as never) }
const unread = async (messageId: string) => { state.body = { messageId }; return (await import('../../server/api/channels/[id]/unread.post')).default({} as never) }

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:'); sqlite.exec(INIT_SQL)
  sqlite.exec(`INSERT INTO server_identity(singleton,id) VALUES(1,'${serverId}');
    INSERT INTO roles(id,key,name,permissions_bitmask) VALUES('member','custom:member','Member',${Permission.sendMessages});
    INSERT INTO users(id,display_name,status,role_id,joined_at) VALUES('owner','Owner','active','member','2026-01-01'),('me','Me','active','member','2026-01-01'),('other','Other','active','member','2026-01-01');
    INSERT INTO server(id,name,owner_id) VALUES('${serverId}','Test','owner');
    INSERT INTO channels(id,name,type,visibility) VALUES('chat','general','text','server'),('secret','secret','text','private');
    INSERT INTO messages(id,channel_id,author_id,content,created_at) VALUES('m1','chat','owner','root','2026-01-01'),('m2','chat','owner','second','2026-01-02'),('s1','secret','owner','secret','2026-01-01');
    INSERT INTO channels(id,name,type,visibility,parent_id,parent_message_id) VALUES('thread','A thread','thread','server','chat','m1');
    INSERT INTO messages(id,channel_id,author_id,content,created_at) VALUES('t1','thread','owner','reply one','2026-01-03'),('t2','thread','owner','reply two','2026-01-04');
    INSERT INTO channel_reads(channel_id,user_id,last_read_message_id,updated_at) VALUES('chat','me','m2','2026-01-02');`)
  state.env = { DB: d1(sqlite) } as unknown as L4Env
  state.userId = 'me'; state.channelId = 'thread'; state.body = {}
  vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
  vi.stubGlobal('getRouterParam', () => state.channelId)
  vi.stubGlobal('readBody', async () => state.body)
})
afterEach(() => { sqlite.close(); vi.unstubAllGlobals() })

it('opening a thread does not follow it; following starts at the tail and unfollow stops parent counts', async () => {
  await advanceChatRead(state.env.DB, 'thread', 'me', 't1', 'now', 0).run()
  expect((await chatAttention(state.env.DB, 'thread', 'me')).following).toBe(false)
  expect(await channelUnreadCount(state.env.DB, 'me', 'chat')).toBe(0)
  await patch({ following: true })
  expect(await channelUnreadCount(state.env.DB, 'me', 'chat')).toBe(0)
  sqlite.exec("INSERT INTO messages(id,channel_id,author_id,content,created_at) VALUES('t3','thread','owner','new','2026-01-05')")
  expect(await channelUnreadCount(state.env.DB, 'me', 'chat')).toBe(1)
  await patch({ following: true })
  expect(await channelUnreadCount(state.env.DB, 'me', 'chat')).toBe(1)
  await patch({ following: false })
  expect(await channelUnreadCount(state.env.DB, 'me', 'chat')).toBe(0)
})

it('mark unread follows the thread and survives an in-flight read from an older tab', async () => {
  await advanceChatRead(state.env.DB, 'thread', 'me', 't2', 'now', 0).run()
  await unread('t1')
  expect(await chatAttention(state.env.DB, 'thread', 'me')).toMatchObject({ following: true, readGeneration: 1 })
  await advanceChatRead(state.env.DB, 'thread', 'me', 't2', 'later', 0).run()
  expect(await channelUnreadCount(state.env.DB, 'me', 'chat')).toBe(2)
  await advanceChatRead(state.env.DB, 'thread', 'me', 't2', 'reopened', 1).run()
  expect(await channelUnreadCount(state.env.DB, 'me', 'chat')).toBe(0)
})

it('refuses private conversations and messages from a different conversation', async () => {
  state.channelId = 'secret'
  await expect(patch({ notifications: 'all' })).rejects.toMatchObject({ statusCode: 404 })
  state.channelId = 'thread'
  await expect(unread('s1')).rejects.toMatchObject({ statusCode: 404 })
  await expect(patch({ notifications: 'all' })).rejects.toMatchObject({ statusCode: 400 })
})

it('previews only unread root and followed replies without moving any cursor', async () => {
  await unread('t1')
  state.channelId = 'chat'
  const result = await (await import('../../server/api/channels/[id]/unread-preview.get')).default({} as never)
  expect(result.messages.map(message => message.id)).toEqual(['t1', 't2'])
  expect(await channelUnreadCount(state.env.DB, 'me', 'chat')).toBe(2)
})

it('lists followed threads and removes private history after access is revoked', async () => {
  await patch({ following: true })
  const list = async () => (await import('../../server/api/servers/[id]/followed-threads.get')).default({} as never)
  expect((await list()).threads.map(thread => thread.id)).toEqual(['thread'])
  sqlite.exec("UPDATE channels SET visibility = 'private' WHERE id = 'chat'")
  expect((await list()).threads).toEqual([])
})

it('honors all/mentions/off and followed threads without granting private-channel access', async () => {
  const recipients = (channelId = 'chat', mentioned: string[] = []) => chatAlertRecipients(state.env, {
    rootId: 'chat', channelId, actorId: 'owner', dm: false, mentioned, candidates: mentioned,
  })
  state.channelId = 'chat'
  await patch({ notifications: 'all' })
  expect(await recipients()).toEqual(['me'])
  await patch({ notifications: 'mentions' })
  expect(await recipients()).toEqual([])
  expect(await recipients('chat', ['me'])).toEqual(['me'])
  await patch({ notifications: 'muted' })
  expect(await recipients('chat', ['me'])).toEqual([])
  await patch({ notifications: 'default' })
  state.channelId = 'thread'; await patch({ following: true })
  expect(await recipients('thread')).toEqual(['me'])
  sqlite.exec("UPDATE channels SET visibility = 'private' WHERE id = 'chat'")
  expect(await recipients('thread')).toEqual([])
})

it('rechecks mute and deletion before delivering a previously queued message', async () => {
  state.channelId = 'chat'
  await patch({ notifications: 'all' })
  expect(await chatPushStillWanted(state.env.DB, 'm2', 'me')).toBe(true)
  await patch({ notifications: 'mentions' })
  expect(await chatPushStillWanted(state.env.DB, 'm2', 'me')).toBe(false)
  sqlite.exec("INSERT INTO message_mentions(message_id,user_id) VALUES('m2','me')")
  expect(await chatPushStillWanted(state.env.DB, 'm2', 'me')).toBe(true)
  await patch({ notifications: 'muted' })
  expect(await chatPushStillWanted(state.env.DB, 'm2', 'me')).toBe(false)
  await patch({ notifications: 'all' })
  sqlite.exec("UPDATE messages SET deleted_at = 'now' WHERE id = 'm2'")
  expect(await chatPushStillWanted(state.env.DB, 'm2', 'me')).toBe(false)
})

it('upgrades existing read threads to explicit follows without changing their cursors', async () => {
  sqlite.exec("INSERT INTO channel_reads(channel_id,user_id,last_read_message_id,updated_at) VALUES('thread','me','t1','before'); DROP TABLE channel_attention")
  sqlite.exec(readFileSync(new URL('../../drizzle/server-migrations/0001_chat_attention.sql', import.meta.url), 'utf8'))
  expect(await chatAttention(state.env.DB, 'thread', 'me')).toEqual({ following: true, notifications: 'default', readGeneration: 0 })
  expect((await chatAttention(state.env.DB, 'chat', 'me')).following).toBe(false)
  expect(sqlite.prepare("SELECT last_read_message_id FROM channel_reads WHERE channel_id='thread' AND user_id='me'").get()).toEqual({ last_read_message_id: 't1' })
  expect(await channelUnreadCount(state.env.DB, 'me', 'chat')).toBe(1)
})
