import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { INIT_SQL } from '../../server/utils/db'
import { d1 } from '../helpers/sqlite-d1'
import type { L4Env } from '../../workers/env'
import { Permission } from '../../shared/permissions'

const serverId = '00000000-0000-4000-8000-000000000001'
const state = vi.hoisted(() => ({ env: null as L4Env | null, body: {} as Record<string, unknown>, pending: [] as Promise<unknown>[] }))
vi.mock('../../server/utils/guards', async () => {
  const { requireChannelAccessForMember, requireMemberForUser } = await import('../../server/utils/channel-access')
  const member = () => requireMemberForUser(state.env!, { id: 'author', kind: 'human', displayName: 'Author', avatarR2Key: null }, serverId)
  return { requireChannelAccess: (_event: unknown, channelId: string, flag?: number) => requireChannelAccessForMember(state.env!, member(), channelId, flag as never, 'POST') }
})
vi.mock('../../server/utils/cf', async original => ({ ...await original<typeof import('../../server/utils/cf')>(), cf: () => ({ env: state.env!, waitUntil: (p: Promise<unknown>) => state.pending.push(p) }) }))

let sqlite: DatabaseSync
let fanout: ReturnType<typeof vi.fn>
const targets: string[] = []

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:'); sqlite.exec(INIT_SQL)
  sqlite.exec(`INSERT INTO server_identity(singleton,id) VALUES(1,'${serverId}');
    INSERT INTO roles(id,key,name,permissions_bitmask) VALUES('member','custom:member','Member',${Permission.sendMessages});
    INSERT INTO users(id,display_name,status,role_id,joined_at) VALUES('owner','Owner','active','member','2026-01-01'),('author','Author','active','member','2026-01-01');
    INSERT INTO server(id,name,owner_id) VALUES('${serverId}','Test','owner');
    INSERT INTO channels(id,name,type,visibility) VALUES('chat','Chat','text','server');
    INSERT INTO messages(id,channel_id,author_id,content,created_at) VALUES('root-0001','chat','author','Shipping update for today','2026-01-01');`)
  fanout = vi.fn(async () => {}); targets.length = 0
  state.env = { DB: d1(sqlite), CHANNEL_DO: { getByName: (name: string) => { targets.push(name); return { fanout } } } } as unknown as L4Env
  state.body = { messageId: 'root-0001', name: 'Launch plan' }; state.pending = []
  vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
  vi.stubGlobal('getRouterParam', () => 'chat')
  vi.stubGlobal('readBody', async () => state.body)
})
afterEach(async () => { await Promise.allSettled(state.pending); sqlite.close(); vi.unstubAllGlobals() })

const create = async () => (await import('../../server/api/channels/[id]/threads.post')).default({} as never)
const list = async () => (await import('../../server/api/channels/[id]/threads.get')).default({} as never)

describe('threads', () => {
  it('tells other open clients about a new thread without blocking on the socket', async () => {
    fanout.mockRejectedValueOnce(new Error('socket down'))
    const { channel, created } = await create()
    expect(created).toBe(true)
    await Promise.all(state.pending)
    expect(targets).toContain('channel:chat')
    expect(fanout).toHaveBeenCalledWith({ t: 'thread.created', messageId: 'root-0001', threadId: channel.id })
  })

  it('lists custom names and counts only replies that still exist', async () => {
    const { channel } = await create()
    sqlite.prepare(`INSERT INTO messages(id,channel_id,author_id,content,created_at,deleted_at) VALUES
      ('reply-1',?,'author','one','2026-01-02',NULL),('reply-2',?,'author','','2026-01-03','2026-01-04')`).run(channel.id, channel.id)
    const { threads } = await list()
    expect(threads).toEqual([expect.objectContaining({ id: channel.id, title: 'Launch plan', replyCount: 1, lastReplyAt: '2026-01-02' })])
  })
})
