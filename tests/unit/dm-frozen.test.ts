import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { INIT_SQL } from '../../server/utils/db'
import { d1 } from '../helpers/sqlite-d1'
import type { L4Env } from '../../workers/env'
import { Permission } from '../../shared/permissions'
import { dmFrozen } from '../../shared/dm'
import { requireChannelAccessForMember, requireMemberForUser } from '../../server/utils/channel-access'
import { toDmDto } from '../../server/utils/dms'

const serverId = '00000000-0000-4000-8000-000000000001'
let sqlite: DatabaseSync
let env: L4Env

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:'); sqlite.exec(INIT_SQL)
  sqlite.exec(`INSERT INTO server_identity(singleton,id) VALUES(1,'${serverId}');
    INSERT INTO roles(id,key,name,permissions_bitmask) VALUES('member','custom:member','Member',${Permission.sendMessages | Permission.startLive});
    INSERT INTO users(id,display_name,status,role_id,joined_at) VALUES('owner','Owner','active','member','2026-01-01'),
      ('ada','Ada','active','member','2026-01-01'),('bob','Bob','active','member','2026-01-01'),('gone','Gone','removed','member','2026-01-01');
    INSERT INTO server(id,name,owner_id) VALUES('${serverId}','Test','owner');
    INSERT INTO channels(id,name,type,visibility) VALUES('pair','dm','dm','private'),('group','dm','dm','private');
    INSERT INTO channel_members(channel_id,user_id,joined_at) VALUES('pair','ada','2026-01-01'),('pair','gone','2026-01-01'),
      ('group','ada','2026-01-01'),('group','bob','2026-01-01'),('group','gone','2026-01-01');`)
  env = { DB: d1(sqlite) } as unknown as L4Env
})
afterEach(() => sqlite.close())

const access = (channelId: string, flag?: number) => requireChannelAccessForMember(env,
  requireMemberForUser(env, { id: 'ada', kind: 'human', displayName: 'Ada', avatarR2Key: null }, serverId), channelId, flag as never, 'POST')
const channel = (id: string) => ({ id, name: 'dm', topic: '', type: 'dm', visibility: 'private', position: 0, liveMeetingId: null, dmKind: null }) as never

describe('frozen direct messages', () => {
  it('freezes only a pair whose other person departed', () => {
    expect(dmFrozen(2, 1)).toBe(true)
    expect(dmFrozen(2, 2)).toBe(false)
    expect(dmFrozen(3, 2)).toBe(false)
  })

  it('keeps a 1:1 with a deactivated member frozen', async () => {
    await expect(access('pair')).resolves.toMatchObject({ frozen: true, perms: 0 })
    await expect(access('pair', Permission.sendMessages)).rejects.toMatchObject({ statusCode: 403 })
    expect((await toDmDto(env, channel('pair'), 'ada', false)).frozen).toBe(true)
  })

  it('lets the rest of a legacy group keep talking and lists the departed member', async () => {
    const group = await access('group', Permission.sendMessages)
    expect(group.frozen).toBe(false)
    expect(group.perms & Permission.sendMessages).toBeTruthy()
    expect(group.participants?.map(participant => participant.id).sort()).toEqual(['ada', 'bob', 'gone'])
    expect((await toDmDto(env, channel('group'), 'ada', false)).frozen).toBe(false)
  })
})
