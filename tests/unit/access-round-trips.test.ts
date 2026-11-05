import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { getDb, INIT_SQL } from '../../server/utils/db'
import { requireChannelAccessForMember, requireMemberForUser } from '../../server/utils/channel-access'
import { readChannelMessages } from '../../server/utils/message-service'
import { hydrateMessages } from '../../server/utils/messages'
import { messages } from '../../drizzle/schema'
import { loadMemberRows } from '../../server/utils/space-access'
import { Permission } from '../../shared/permissions'
import type { L4Env } from '../../workers/env'
import { databaseRequests, sequentialRoundTrips } from '../helpers/round-trips'
import { d1 } from '../helpers/sqlite-d1'

const serverId = '00000000-0000-4000-8000-000000000001'
const person = (id: string) => ({ id, kind: 'human' as const, displayName: id, avatarR2Key: null })
let sqlite: DatabaseSync
let env: L4Env

beforeEach(() => {
  vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
  sqlite = new DatabaseSync(':memory:'); sqlite.exec(INIT_SQL)
  sqlite.exec(`INSERT INTO server_identity(singleton,id) VALUES(1,'${serverId}');
    INSERT INTO roles(id,key,name,permissions_bitmask) VALUES('member','custom:member','Member',${Permission.sendMessages});
    INSERT INTO users(id,display_name,status,role_id,joined_at) VALUES('owner','Owner','active','member','2026-01-01'),('me','Me','active','member','2026-01-01'),('gone','Gone','removed','member','2026-01-01');
    INSERT INTO server(id,name,owner_id) VALUES('${serverId}','Test','owner');
    INSERT INTO channels(id,name,type,visibility) VALUES('open','open','text','server'),('secret','secret','text','private'),('walled','walled','text','server');
    INSERT INTO messages(id,channel_id,author_id,content,created_at) VALUES('m1','open','owner','a','2026-01-01'),('m2','secret','owner','b','2026-01-01');
    INSERT INTO channels(id,name,type,visibility,parent_id,parent_message_id) VALUES('thread','thread','thread','server','open','m1'),('secret-thread','secret-thread','thread','server','secret','m2');
    INSERT INTO channel_role_denies(channel_id,role_id,deny_mask,created_at) VALUES('walled','member',${Permission.sendMessages},'2026-01-01');`)
  sqlite.exec("INSERT OR IGNORE INTO space_members(space_id,user_id,role,joined_at) SELECT id,'me','member','2026-01-01' FROM spaces")
  env = { DB: d1(sqlite) } as unknown as L4Env
})
afterEach(() => { sqlite.close(); vi.unstubAllGlobals() })

const member = (id = 'me') => requireMemberForUser(env, person(id), serverId)

it('reads who a Member is in one round trip, and not at all when the route check already did', async () => {
  await member() // The Server ID stays known for the isolate's life.
  expect(await sequentialRoundTrips(env, env => requireMemberForUser(env, person('me'), serverId))).toBe(1)
  const { rows } = await loadMemberRows(env, 'me')
  expect(await sequentialRoundTrips(env, env => requireMemberForUser(env, person('me'), serverId, undefined, { memberRows: rows }))).toBe(0)
})

it('takes one more round trip for someone who does not reach every Space, to list what it excludes', async () => {
  await member()
  sqlite.exec("DELETE FROM space_members WHERE user_id='me'")
  expect(await sequentialRoundTrips(env, env => requireMemberForUser(env, person('me'), serverId))).toBe(2)
})

it('never takes rows the route check read for someone else', async () => {
  const { rows } = await loadMemberRows(env, 'owner')
  await expect(requireMemberForUser(env, person('gone'), serverId, undefined, { memberRows: rows })).rejects.toMatchObject({ statusCode: 403 })
})

it('decides channel access in one round trip for a known Member, and two for a Thread', async () => {
  const known = await member()
  expect(await sequentialRoundTrips(env, env => requireChannelAccessForMember(env, known, 'open'))).toBe(1)
  expect(await sequentialRoundTrips(env, env => requireChannelAccessForMember(env, known, 'thread'))).toBe(2)
})

it('reports a missing channel before a refused Member', async () => {
  const refused = requireMemberForUser(env, person('gone'), serverId)
  await expect(requireChannelAccessForMember(env, refused, 'nothing')).rejects.toMatchObject({ statusCode: 404 })
  await expect(requireChannelAccessForMember(env, requireMemberForUser(env, person('gone'), serverId), 'open')).rejects.toMatchObject({ statusCode: 403 })
})

it('keeps refusing what it refused: a private channel, its Threads, and a Role denied on one channel', async () => {
  const known = await member()
  await expect(requireChannelAccessForMember(env, known, 'secret')).rejects.toMatchObject({ statusCode: 404 })
  await expect(requireChannelAccessForMember(env, known, 'secret-thread')).rejects.toMatchObject({ statusCode: 404 })
  await expect(requireChannelAccessForMember(env, known, 'walled', Permission.sendMessages)).rejects.toMatchObject({ statusCode: 403 })
  await expect(requireChannelAccessForMember(env, known, 'open', Permission.sendMessages)).resolves.toMatchObject({ channel: { id: 'open', parentId: null } })
  sqlite.exec("INSERT INTO channel_members(channel_id,user_id,joined_at) VALUES('secret','me','2026-01-01')")
  await expect(requireChannelAccessForMember(env, known, 'secret-thread')).resolves.toMatchObject({ channel: { id: 'secret-thread', parentId: 'secret' }, accessRootType: 'text' })
  await expect(requireChannelAccessForMember(env, member(), 'secret-thread')).resolves.toMatchObject({ channel: { id: 'secret-thread' } })
})

it('lifts a Role denial for the Owner, and keeps a private channel to its members', async () => {
  const owner = await member('owner')
  await expect(requireChannelAccessForMember(env, owner, 'walled', Permission.sendMessages)).resolves.toMatchObject({ channel: { id: 'walled' } })
  await expect(requireChannelAccessForMember(env, owner, 'secret')).rejects.toMatchObject({ statusCode: 404 })
})

it('reads a page of messages in three round trips, and its details in one request', async () => {
  const known = await member()
  const rows = await getDb(env.DB).select().from(messages)
  expect(await databaseRequests(env, env => hydrateMessages(env, rows, 'me'))).toBe(1)
  expect(await sequentialRoundTrips(env, env => readChannelMessages(env, known, 'open'))).toBe(3)
  expect(await sequentialRoundTrips(env, env => readChannelMessages(env, known, 'thread'))).toBe(4)
})

it('keeps every detail of a message when they are read together', async () => {
  sqlite.exec(`INSERT INTO messages(id,channel_id,author_id,content,reply_to_id,created_at) VALUES('m3','open','me','c','m1','2026-01-02');
    INSERT INTO message_pins(message_id,pinned_by,pinned_at) VALUES('m3','gone','2026-01-03');
    INSERT INTO message_reactions(message_id,user_id,emoji,created_at) VALUES('m3','me','+1','2026-01-03'),('m3','owner','+1','2026-01-03');
    INSERT INTO message_mentions(message_id,user_id) VALUES('m3','owner');
    INSERT INTO attachments(id,message_id,channel_id,uploader_id,r2_key,filename,content_type,size_bytes,created_at) VALUES('a3','m3','open','me','k3','c.txt','text/plain',1,'2026-01-03'),('a1','m1','open','owner','k1','a.txt','text/plain',1,'2026-01-03');`)
  const rows = await getDb(env.DB).select().from(messages)
  const hydrated = await hydrateMessages(env, rows, 'me')
  expect(hydrated.find(message => message.id === 'm3')).toMatchObject({
    author: { id: 'me' },
    replyTo: { id: 'm1', content: 'a', attachmentCount: 1 },
    pin: { pinnedBy: { id: 'gone' } },
    reactions: [{ emoji: '+1', count: 2, me: true }],
    mentions: ['owner'],
    attachments: [{ id: 'a3' }],
    threadId: null,
  })
  expect(hydrated.find(message => message.id === 'm1')).toMatchObject({ replyTo: null, threadId: 'thread' })
  const [alone] = await hydrateMessages(env, rows.filter(row => row.id === 'm1'), 'me')
  expect(alone).toMatchObject({ id: 'm1', replyTo: null, attachments: [{ id: 'a1' }] })
})

it('seeks a page of messages and its Threads without scanning or sorting the channel', async () => {
  sqlite.exec("INSERT INTO messages(id,channel_id,author_id,content,reply_to_id,created_at) VALUES('m3','open','me','c','m1','2026-01-02')")
  const known = await member()
  const seen = new Set<string>()
  const prepare = sqlite.prepare.bind(sqlite)
  vi.spyOn(sqlite, 'prepare').mockImplementation((sql: string) => { seen.add(sql); return prepare(sql) })
  await readChannelMessages(env, known, 'open')
  await readChannelMessages(env, known, 'open', { cursor: 'm9' })
  const plans = [...seen].map(sql => prepare(`EXPLAIN QUERY PLAN ${sql}`).all().map(row => (row as { detail: string }).detail).join(' | '))
  expect(plans.filter(plan => /SCAN (messages|channels)\b|TEMP B-TREE FOR ORDER BY/.test(plan))).toEqual([])
  expect(plans.some(plan => plan.includes('messages_channel_id_idx'))).toBe(true)
  expect(plans.some(plan => plan.includes('channels_thread_root_unique'))).toBe(true)
})

it('still counts unread through the index of live messages', () => {
  const plan = sqlite.prepare("EXPLAIN QUERY PLAN SELECT 1 FROM messages m WHERE m.channel_id = 'open' AND m.deleted_at IS NULL AND m.id > '' LIMIT 100").all()
  expect(JSON.stringify(plan)).toContain('messages_live_channel_id_idx')
})
