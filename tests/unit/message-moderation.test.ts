import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { INIT_SQL } from '../../server/utils/db'
import { d1 } from '../helpers/sqlite-d1'
import type { L4Env } from '../../workers/env'
import type { AuthorizationContext } from '../../shared/authorization'
import { Permission } from '../../shared/permissions'
import { requireMemberForUser } from '../../server/utils/channel-access'
import { requireMessageMember, sendChannelMessage, UPLOAD_BYTES_PER_HOUR } from '../../server/utils/message-service'
import { ChannelDurableObject } from '../../workers/channel-do'

vi.mock('cloudflare:workers', () => ({ DurableObject: class { constructor(protected ctx: unknown, protected env: unknown) {} } }))
const serverId = '00000000-0000-4000-8000-000000000001'
const state = vi.hoisted(() => ({ env: null as L4Env | null, userId: 'author', param: 'm-author', pending: [] as Promise<unknown>[] }))
const user = (id: string) => ({ id, kind: 'human' as const, displayName: id, avatarR2Key: null })
vi.mock('../../server/utils/guards', async () => {
  const { requireChannelAccessForMember, requireMemberForUser } = await import('../../server/utils/channel-access')
  const member = () => requireMemberForUser(state.env!, user(state.userId), serverId)
  return {
    requireMember: member,
    requireChannelMember: (_event: unknown, channelId: string, flag?: number) => requireChannelAccessForMember(state.env!, member(), channelId, flag as never, 'POST'),
    requireChannelAccess: (_event: unknown, channelId: string) => requireChannelAccessForMember(state.env!, member(), channelId),
  }
})
vi.mock('../../server/utils/cf', async original => ({ ...await original<typeof import('../../server/utils/cf')>(), cf: () => ({ env: state.env!, waitUntil: (p: Promise<unknown>) => state.pending.push(p) }) }))

let sqlite: DatabaseSync
let counts: Map<string, number>
let fanout: ReturnType<typeof vi.fn>
let limiterDown = false
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0])
let upload: { name: string; filename: string; data: Uint8Array }

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:'); sqlite.exec(INIT_SQL)
  sqlite.exec(`INSERT INTO server_identity(singleton,id) VALUES(1,'${serverId}');
    INSERT INTO roles(id,key,name,permissions_bitmask) VALUES('muted','custom:muted','Muted',0),
      ('member','custom:member','Member',${Permission.sendMessages | Permission.attachFiles | Permission.mcpConnect}),
      ('moderator','custom:mod','Moderator',${Permission.sendMessages | Permission.manageChannels});
    INSERT INTO users(id,display_name,status,role_id,joined_at) VALUES('owner','Owner','active','member','2026-01-01'),
      ('author','Author','active','muted','2026-01-01'),('member','Member','active','member','2026-01-01'),
      ('mod','Moderator','active','moderator','2026-01-01'),('gone','Gone','removed','member','2026-01-01');
    INSERT INTO server(id,name,owner_id) VALUES('${serverId}','Test','owner');
    INSERT INTO channels(id,name,type,visibility) VALUES('chat','Chat','text','server'),('dm','dm','dm','private');
    INSERT INTO channel_members(channel_id,user_id,joined_at) VALUES('dm','author','2026-01-01'),('dm','gone','2026-01-01');
    INSERT INTO messages(id,channel_id,author_id,content,created_at) VALUES('m-author','chat','author','hello','2026-01-01'),
      ('m-member','chat','member','spam','2026-01-01'),('m-dm','dm','author','bye','2026-01-01');`)
  counts = new Map(); limiterDown = false
  const take = (key: string) => async (limit: number) => {
    if (limiterDown) throw new Error('limiter down')
    const used = counts.get(key) ?? 0
    counts.set(key, used + 1)
    return used < limit
  }
  fanout = vi.fn(async () => {})
  state.env = { DB: d1(sqlite), FILES: { put: vi.fn(async () => {}), delete: vi.fn(async () => {}) }, RATE_LIMIT_DO: { getByName: (key: string) => ({ take: take(key) }) },
    CHANNEL_DO: { getByName: () => ({ fanout }) }, AGENT_DO: { getByName: () => ({ receiveMessage: async () => 'x' }) },
    SERVER_DO: { getByName: () => ({ notifyChannelActivity: async () => {}, notifyChannelRead: async () => {} }) } } as unknown as L4Env
  state.userId = 'author'; state.param = 'm-author'; state.pending = []
  upload = { name: 'file', filename: 'photo.png', data: png }
  vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
  vi.stubGlobal('getRouterParam', () => state.param)
  vi.stubGlobal('readBody', async () => ({ emoji: '👍' }))
  vi.stubGlobal('readMultipartFormData', async () => [upload])
})
afterEach(async () => { await Promise.allSettled(state.pending); sqlite.close(); vi.unstubAllGlobals() })

const schedule = (p: Promise<unknown>) => { state.pending.push(p) }
const handler = async (path: string) => (await import(path)).default({} as never)
const deleteHttp = () => handler('../../server/api/messages/[id].delete')
const react = () => handler('../../server/api/messages/[id]/reactions.post')
const attach = () => handler('../../server/api/channels/[id]/attachments.post')
const deletedAt = (id: string) => (sqlite.prepare('SELECT deleted_at FROM messages WHERE id = ?').get(id) as { deleted_at: string | null }).deleted_at
const audits = () => sqlite.prepare("SELECT actor_id, target_id, meta_json FROM audit_log WHERE action = 'message.delete'").all() as Array<{ actor_id: string; target_id: string; meta_json: string }>

function socketDo() {
  const instance = Object.create(ChannelDurableObject.prototype)
  const data = new Map<string, unknown>()
  const storage = {
    get: async (key: string) => data.get(key),
    put: async (key: string, value: unknown) => { data.set(key, value) },
    delete: async (key: string | string[]) => { for (const k of [key].flat()) data.delete(k) },
    list: async ({ prefix, startAfter, limit }: { prefix: string; startAfter?: string; limit: number }) =>
      new Map([...data].filter(([k]) => k.startsWith(prefix) && (!startAfter || k > startAfter)).sort(([a], [b]) => a.localeCompare(b)).slice(0, limit)),
  }
  Object.assign(instance, { env: state.env, ctx: { id: { name: 'channel:chat' }, storage, getWebSockets: () => [], waitUntil: (p: Promise<unknown>) => state.pending.push(p) } })
  return { instance, data }
}

describe('message send rate limit', () => {
  it('refuses HTTP and MCP sends beyond the shared per-member budget', async () => {
    const member = await requireMemberForUser(state.env!, user('member'), serverId)
    for (let i = 0; i < 30; i++) await sendChannelMessage(state.env!, member, 'chat', { content: `hi ${i}` }, schedule)
    await expect(sendChannelMessage(state.env!, member, 'chat', { content: 'one more' }, schedule))
      .rejects.toMatchObject({ statusCode: 429, data: { error: { code: 'rate_limited' } } })
    const mcp: AuthorizationContext = { serverId, principal: { id: 'member', kind: 'human', roleId: 'member', roleName: 'Member', permissions: 0, isOwner: false },
      credential: { kind: 'mcp', id: 'conn', clientId: 'client', scopes: ['messages:read', 'messages:write'] } }
    await expect(sendChannelMessage(state.env!, await requireMessageMember(state.env!, mcp, 'messages:write'), 'chat', { content: 'mcp' }, schedule))
      .rejects.toMatchObject({ statusCode: 429 })
    expect(counts.get('user:member:msg')).toBe(32)
  })

  it('fails closed when the limiter is unavailable and does not charge idempotent redelivery', async () => {
    const member = await requireMemberForUser(state.env!, user('member'), serverId)
    await sendChannelMessage(state.env!, member, 'chat', { content: 'reminder' }, schedule, 'delivery-1', false)
    limiterDown = true
    await expect(sendChannelMessage(state.env!, member, 'chat', { content: 'reminder' }, schedule, 'delivery-1', false)).resolves.toMatchObject({ message: { id: 'delivery-1' } })
    await expect(sendChannelMessage(state.env!, member, 'chat', { content: 'new' }, schedule)).rejects.toMatchObject({ statusCode: 503 })
  })

  it('shares the budget with socket sends and expires idempotency keys', async () => {
    const { instance, data } = socketDo()
    counts.set('user:member:msg', 30)
    const ws = { send: vi.fn() }
    const authz = { serverId, perms: Permission.sendMessages, frozen: false, mailbox: false }
    await instance.onCreate(ws, { userId: 'member', user: user('member') }, authz, { t: 'message.create', content: 'hi', clientId: 'c1' })
    expect(JSON.parse(ws.send.mock.calls[0]![0])).toMatchObject({ t: 'error', code: 'rate_limited', clientId: 'c1' })
    counts.clear()
    data.set('idem:member:old', { id: 'old-message', at: Date.now() - 25 * 60 * 60_000 })
    data.set('idem:member:legacy', 'legacy-message')
    await instance.onCreate(ws, { userId: 'member', user: user('member') }, authz, { t: 'message.create', content: 'hi', clientId: 'c2' })
    expect(data.get('idem:member:c2')).toMatchObject({ id: expect.any(String), at: expect.any(Number) })
    expect(data.has('idem:member:old')).toBe(false)
    expect(data.has('idem:member:legacy')).toBe(false)
  })
})

describe('upload and reaction limits', () => {
  it('limits upload count per window', async () => {
    state.userId = 'member'; state.param = 'chat'
    counts.set('user:member:upload', 40)
    await expect(attach()).rejects.toMatchObject({ statusCode: 429, data: { error: { code: 'rate_limited' } } })
    expect(state.env!.FILES!.put).not.toHaveBeenCalled()
  })

  it('limits uploaded bytes per hour', async () => {
    state.userId = 'member'; state.param = 'chat'
    sqlite.prepare(`INSERT INTO attachments(id,channel_id,uploader_id,r2_key,filename,content_type,size_bytes,created_at) VALUES('big','chat','member','k','a.png','image/png',?,?)`)
      .run(UPLOAD_BYTES_PER_HOUR - 5, new Date().toISOString())
    await expect(attach()).rejects.toMatchObject({ statusCode: 429 })
    sqlite.exec("UPDATE attachments SET created_at = '2026-01-01T00:00:00.000Z'")
    await expect(attach()).resolves.toMatchObject({ attachment: { filename: 'photo.png' } })
  })

  it('limits reactions', async () => {
    state.userId = 'member'; state.param = 'm-member'
    for (let i = 0; i < 30; i++) await react()
    await expect(react()).rejects.toMatchObject({ statusCode: 429, data: { error: { code: 'rate_limited' } } })
  })
})

describe('message deletion', () => {
  it('lets an author without Send messages delete their own message over HTTP', async () => {
    await expect(deleteHttp()).resolves.toEqual({ ok: true })
    expect(deletedAt('m-author')).not.toBeNull()
    expect(audits()).toEqual([])
  })

  it('lets an author delete in a frozen DM', async () => {
    state.param = 'm-dm'
    await expect(deleteHttp()).resolves.toEqual({ ok: true })
    expect(deletedAt('m-dm')).not.toBeNull()
  })

  it('lets a Manage channels moderator delete and audits it', async () => {
    state.userId = 'mod'; state.param = 'm-member'
    await expect(deleteHttp()).resolves.toEqual({ ok: true })
    expect(deletedAt('m-member')).not.toBeNull()
    expect(audits()).toMatchObject([{ actor_id: 'mod', target_id: 'm-member' }])
    expect(JSON.parse(audits()[0]!.meta_json)).toMatchObject({ channelId: 'chat', authorId: 'member' })
    expect(fanout).toHaveBeenCalledWith({ t: 'message.delete', id: 'm-member' })
  })

  it('denies a non-author without Manage channels', async () => {
    state.userId = 'member'; state.param = 'm-author'
    await expect(deleteHttp()).rejects.toMatchObject({ statusCode: 403 })
    expect(deletedAt('m-author')).toBeNull()
  })

  it('applies the same rules on the socket', async () => {
    const { instance } = socketDo()
    const ws = { send: vi.fn() }
    await instance.onDelete(ws, { userId: 'author' }, { serverId, perms: 0, frozen: true, mailbox: false }, 'm-author')
    expect(deletedAt('m-author')).not.toBeNull()
    await instance.onDelete(ws, { userId: 'author' }, { serverId, perms: Permission.sendMessages, mailbox: false }, 'm-member')
    expect(JSON.parse(ws.send.mock.calls.at(-1)![0])).toMatchObject({ t: 'error', code: 'forbidden' })
    await instance.onDelete(ws, { userId: 'mod' }, { serverId, perms: Permission.manageChannels, mailbox: true }, 'm-member')
    expect(deletedAt('m-member')).toBeNull()
    await instance.onDelete(ws, { userId: 'mod' }, { serverId, perms: Permission.manageChannels, mailbox: false }, 'm-member')
    expect(deletedAt('m-member')).not.toBeNull()
    expect(audits()).toMatchObject([{ actor_id: 'mod', target_id: 'm-member' }])
  })
})
