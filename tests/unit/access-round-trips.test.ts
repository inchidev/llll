import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { INIT_SQL } from '../../server/utils/db'
import { requireChannelAccessForMember, requireMemberForUser } from '../../server/utils/channel-access'
import { loadMemberRows } from '../../server/utils/space-access'
import { Permission } from '../../shared/permissions'
import type { L4Env } from '../../workers/env'
import { sequentialRoundTrips } from '../helpers/round-trips'
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

it('takes one more round trip only for a Member outside some Space, to list what it excludes', async () => {
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
