import { DatabaseSync } from 'node:sqlite'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { INIT_SQL } from '../../server/utils/db'
import { Permission } from '../../shared/permissions'
import type { AuthorizationContext } from '../../shared/authorization'
import type { L4Env } from '../../workers/env'
import { d1 } from '../helpers/sqlite-d1'
import { requireChannelAccessForMember, requireMemberForUser } from '../../server/utils/channel-access'
import {
  deleteChannelMessage, editChannelMessage, listMessageChannels, readChannelMessages, requireMessageMember,
  searchChannelMessages, sendChannelMessage, setMessagePin, setMessageReaction,
} from '../../server/utils/message-service'
import { loadInbox } from '../../server/utils/inbox-service'
import { recordScheduleFailure } from '../../server/utils/schedule-service'
import type { Schedule } from '../../shared/schedules'
import { ChannelDurableObject } from '../../workers/channel-do'

vi.mock('cloudflare:workers', () => ({ DurableObject: class { constructor(protected ctx: unknown, protected env: unknown) {} } }))
const serverId = '00000000-0000-4000-8000-000000000001'
const state = vi.hoisted(() => ({ env: null as L4Env | null, actor: 'admin-001', id: 'random-001', body: {} as Record<string, unknown>, pending: [] as Promise<unknown>[] }))
vi.mock('../../server/utils/auth', () => ({ requireUser: async () => ({ id: state.actor, kind: 'human', displayName: state.actor, avatarR2Key: null }) }))
vi.mock('../../server/utils/cf', async original => ({
  ...await original<typeof import('../../server/utils/cf')>(),
  cf: () => ({ env: state.env!, waitUntil: (promise: Promise<unknown>) => { state.pending.push(promise) } }),
}))
const live = vi.hoisted(() => ({ revalidateLiveRooms: vi.fn(async () => {}) }))
vi.mock('../../server/utils/live', () => ({ revalidateLiveRooms: live.revalidateLiveRooms, liveRoom: vi.fn() }))

const user = (id: string, kind: 'human' | 'agent' = 'human') => ({ id, kind, displayName: id, avatarR2Key: null })
const schedule = (promise: Promise<unknown>) => { state.pending.push(promise) }
let sqlite: DatabaseSync
let notify: ReturnType<typeof vi.fn>
let cancel: ReturnType<typeof vi.fn>
let fanout: ReturnType<typeof vi.fn>

beforeAll(() => {
  vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
  vi.stubGlobal('getRouterParam', () => state.id)
  vi.stubGlobal('readBody', async () => state.body)
  vi.stubGlobal('getQuery', () => ({}))
})
afterAll(() => vi.unstubAllGlobals())
beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec(INIT_SQL)
  const manager = Permission.manageChannels | Permission.sendMessages | Permission.attachFiles | Permission.startLive | Permission.readTasks | Permission.mcpConnect
  sqlite.exec(`
    INSERT INTO server_identity(singleton,id) VALUES(1,'${serverId}');
    INSERT INTO roles(id,key,name,permissions_bitmask) VALUES('admin-role','custom:admin','Admin',${manager}),
      ('member-role','custom:member','Member',${Permission.sendMessages | Permission.attachFiles | Permission.startLive | Permission.mcpConnect});
    INSERT INTO users(id,kind,display_name,status,role_id,joined_at) VALUES
      ('owner-001','human','Owner','active','member-role','2026-10-23'),
      ('admin-001','human','Admin','active','admin-role','2026-10-23'),
      ('admin-002','human','Second admin','active','admin-role','2026-10-23'),
      ('member-001','human','Member','active','member-role','2026-10-23'),
      ('agent-001','agent','Agent','active','member-role','2026-10-23');
    INSERT INTO agents(user_id,created_by,harness) VALUES('agent-001','admin-001','pi');
    INSERT INTO server(id,name,owner_id) VALUES('${serverId}','Archive','owner-001');
    INSERT INTO channels(id,name,type,visibility,created_by,position) VALUES
      ('general-001','general','text','server','admin-001',0),('random-001','random','text','server','admin-001',1),
      ('secret-001','secret','text','private','admin-001',2),('orphan-001','orphan','text','private',NULL,3),
      ('mailbox-001','support','text','private',NULL,4),('discussion-001','task-1','text','server',NULL,5),
      ('dm-001','dm','dm','private',NULL,0);
    INSERT INTO channel_members(channel_id,user_id,joined_at) VALUES('secret-001','admin-001','2026-10-23'),('secret-001','admin-002','2026-10-23'),
      ('orphan-001','admin-001','2026-10-23'),('dm-001','admin-001','2026-10-23'),('dm-001','member-001','2026-10-23');
    INSERT INTO email_domains(id,zone_id,domain,app_hostname) VALUES('domain-001','zone','example.test','mail.example.test');
    INSERT INTO email_mailboxes(channel_id,domain_id,local_part,display_name) VALUES('mailbox-001','domain-001','support','Support');
    INSERT INTO task_boards(id,name,created_by) VALUES('board-001','Board','admin-001');
    INSERT INTO tasks(id,board_id,title,created_by,discussion_channel_id) VALUES('task-001','board-001','Task','admin-001','discussion-001');
    INSERT INTO messages(id,channel_id,author_id,content,created_at) VALUES
      ('m-001','random-001','member-001','Quarterly roadmap notes','2026-10-23T00:00:00Z'),
      ('m-002','random-001','admin-001','Roadmap for <@member-001>','2026-10-23T00:00:01Z');
    INSERT INTO message_mentions(message_id,user_id) VALUES('m-002','member-001');
    INSERT INTO channels(id,name,type,visibility,parent_id,parent_message_id) VALUES('thread-001','Notes','thread','server','random-001','m-001');
    INSERT INTO messages(id,channel_id,author_id,content,created_at) VALUES('t-001','thread-001','member-001','Roadmap reply','2026-10-23T00:00:02Z');
  `)
  notify = vi.fn(async () => {})
  cancel = vi.fn(async () => {})
  fanout = vi.fn(async () => {})
  state.env = {
    DB: d1(sqlite),
    SERVER_DO: { getByName: () => ({ notifyChannelsChanged: notify, notifyChannelActivity: async () => {}, notifyChannelRead: async () => {} }) },
    CHANNEL_DO: { getByName: () => ({ fanout }) },
    AGENT_RUN_DO: { getByName: () => ({ cancel }) },
    AGENT_DO: { getByName: () => ({ receiveMessage: async () => 'x' }) },
  } as unknown as L4Env
  state.actor = 'admin-001'
  state.id = 'random-001'
  state.body = {}
  state.pending = []
  live.revalidateLiveRooms.mockClear()
})
afterEach(async () => { await Promise.allSettled(state.pending); sqlite.close() })

const call = async (path: string, method: string) => (await import(path)).default({ method, path: `/api/channels/${state.id}` } as never)
const archive = () => call('../../server/api/channels/[id]/archive.put', 'PUT')
const restore = () => call('../../server/api/channels/[id]/archive.delete', 'DELETE')
const archivedAt = (id: string) => (sqlite.prepare('SELECT archived_at FROM channels WHERE id=?').get(id) as { archived_at: string | null }).archived_at
const audit = (action: string) => sqlite.prepare('SELECT actor_id, target_id FROM audit_log WHERE action=?').all(action)
const member = (id: string) => requireMemberForUser(state.env!, user(id), serverId)
const archived = { statusCode: 409, data: { error: { code: 'channel_archived' } } }
const markArchived = (id = 'random-001') => sqlite.prepare("UPDATE channels SET archived_at='2026-10-24T00:00:00Z', archived_by='admin-001' WHERE id=?").run(id)

function channelDo(channelId: string) {
  const instance = Object.create(ChannelDurableObject.prototype)
  const data = new Map<string, unknown>()
  const storage = { get: async (key: string) => data.get(key), put: async (key: string, value: unknown) => { data.set(key, value) }, delete: async () => {}, list: async () => new Map() }
  Object.assign(instance, { env: state.env, ctx: { id: { name: `channel:${channelId}` }, storage, getWebSockets: () => [], waitUntil: schedule } })
  return instance as {
    loadAuthz: (userId: string) => Promise<{ archived: boolean, perms: number } | null>
    onCreate: (ws: unknown, sock: unknown, authz: unknown, body: unknown) => Promise<void>
    onUpdate: (ws: unknown, sock: unknown, authz: unknown, body: unknown) => Promise<void>
    joinLiveNow: (user: unknown, opts: unknown) => Promise<{ ok: boolean, code?: string }>
    postAgentMessage: (input: unknown) => Promise<unknown>
  }
}

describe('archiving and restoring a channel', () => {
  it('needs Manage channels', async () => {
    state.actor = 'member-001'
    await expect(archive()).rejects.toMatchObject({ statusCode: 403 })
    expect(archivedAt('random-001')).toBeNull()
  })

  it('archives a server channel, audits it, cancels its Runs, ends Live and tells clients', async () => {
    sqlite.exec(`INSERT INTO agent_sessions(id,agent_id,channel_id,created_at,updated_at) VALUES('session-001','agent-001','thread-001','2026-10-23','2026-10-23');
      INSERT INTO agent_runs(id,session_id,agent_id,channel_id,initiated_by,idempotency_key,status,prompt,model,instructions,mandate_json,deadline,created_at,updated_at) VALUES
        ('run-001','session-001','agent-001','thread-001','admin-001','k1','running','Go','model','','{}','2999-01-01','2026-10-23','2026-10-23'),
        ('run-002','session-001','agent-001','thread-001','admin-001','k2','completed','Done','model','','{}','2999-01-01','2026-10-23','2026-10-23')`)
    await expect(archive()).resolves.toEqual({ ok: true, archived: true, changed: true, cancelledRuns: 1 })
    expect(archivedAt('random-001')).not.toBeNull()
    expect(sqlite.prepare('SELECT archived_by FROM channels WHERE id=?').get('random-001')).toEqual({ archived_by: 'admin-001' })
    expect(audit('channel.archive')).toEqual([{ actor_id: 'admin-001', target_id: 'random-001' }])
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(live.revalidateLiveRooms).toHaveBeenCalledWith(state.env, ['random-001'])
    await Promise.all(state.pending)
    expect(notify).toHaveBeenCalledWith({ t: 'channels.changed', serverId, deletedIds: [], parentIds: [], updatedIds: ['random-001', 'thread-001'] }, undefined)
  })

  it('restores it, audited and announced, and repeats are no-ops', async () => {
    await archive()
    await expect(archive()).resolves.toMatchObject({ changed: false })
    notify.mockClear()
    await expect(restore()).resolves.toEqual({ ok: true, archived: false, changed: true })
    expect(archivedAt('random-001')).toBeNull()
    expect(sqlite.prepare('SELECT archived_by FROM channels WHERE id=?').get('random-001')).toEqual({ archived_by: null })
    expect(audit('channel.restore')).toEqual([{ actor_id: 'admin-001', target_id: 'random-001' }])
    await Promise.all(state.pending)
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ t: 'channels.changed', updatedIds: ['random-001', 'thread-001'] }), undefined)
    await expect(restore()).resolves.toMatchObject({ changed: false })
    expect(audit('channel.restore')).toHaveLength(1)
  })

  it('lets only the creator archive a private channel and tells only its members', async () => {
    state.id = 'secret-001'
    state.actor = 'admin-002'
    await expect(archive()).rejects.toMatchObject({ statusCode: 403 })
    state.actor = 'admin-001'
    await expect(archive()).resolves.toMatchObject({ changed: true })
    await Promise.all(state.pending)
    expect(notify.mock.calls[0]![1]).toEqual(['admin-001', 'admin-002'])
    state.actor = 'admin-002'
    await expect(restore()).rejects.toMatchObject({ statusCode: 403 })
    state.id = 'orphan-001'
    state.actor = 'admin-001'
    await expect(archive()).rejects.toMatchObject({ statusCode: 403 })
  })

  it('archives only Chat channels: not Threads, Direct Messages or task discussions', async () => {
    for (const id of ['thread-001', 'dm-001', 'discussion-001']) {
      state.id = id
      await expect(archive()).rejects.toMatchObject({ statusCode: expect.any(Number) })
      expect(archivedAt(id)).toBeNull()
    }
  })

  it('never archives the last active Chat channel; mailboxes and discussions do not count', async () => {
    sqlite.exec("DELETE FROM channels WHERE id IN ('secret-001', 'orphan-001')")
    await archive()
    state.id = 'general-001'
    await expect(archive()).rejects.toMatchObject({ statusCode: 400, data: { error: { code: 'last_channel' } } })
    expect(archivedAt('general-001')).toBeNull()
    await expect(call('../../server/api/channels/[id].delete', 'DELETE')).rejects.toMatchObject({ statusCode: 400 })
    // An archived channel is already out of the count, so it can still be deleted.
    state.id = 'random-001'
    await expect(call('../../server/api/channels/[id].delete', 'DELETE')).resolves.toEqual({ ok: true })
  })
})

describe('an archived channel is read-only', () => {
  beforeEach(() => { markArchived() })

  it('refuses HTTP, MCP and Thread sends and edits for everyone, the Server Owner included', async () => {
    state.actor = 'member-001'
    state.body = { content: 'hello' }
    await expect(call('../../server/api/channels/[id]/messages.post', 'POST')).rejects.toMatchObject(archived)
    const mcp: AuthorizationContext = { serverId, principal: { id: 'member-001', kind: 'human', roleId: 'member-role', roleName: 'Member', permissions: 0, isOwner: false },
      credential: { kind: 'mcp', id: 'conn', clientId: 'client', scopes: ['messages:read', 'messages:write'] } }
    await expect(sendChannelMessage(state.env!, await requireMessageMember(state.env!, mcp, 'messages:write'), 'random-001', { content: 'mcp' }, schedule)).rejects.toMatchObject(archived)
    await expect(sendChannelMessage(state.env!, await member('member-001'), 'thread-001', { content: 'reply' }, schedule)).rejects.toMatchObject(archived)
    await expect(sendChannelMessage(state.env!, await member('owner-001'), 'random-001', { content: 'owner' }, schedule)).rejects.toMatchObject(archived)
    await expect(editChannelMessage(state.env!, await member('member-001'), 'm-001', { content: 'edited' })).rejects.toMatchObject(archived)
    state.id = 'm-001'
    state.body = { content: 'edited' }
    await expect(call('../../server/api/messages/[id].patch', 'PATCH')).rejects.toMatchObject(archived)
    expect(sqlite.prepare("SELECT count(*) AS n FROM messages WHERE channel_id IN ('random-001','thread-001')").get()).toEqual({ n: 3 })
  })

  it('refuses reactions, pins, Thread creation, uploads and channel changes', async () => {
    state.actor = 'member-001'
    state.id = 'm-001'
    state.body = { emoji: '👍' }
    await expect(call('../../server/api/messages/[id]/reactions.post', 'POST')).rejects.toMatchObject(archived)
    await expect(setMessageReaction(state.env!, await member('member-001'), 'm-001', { emoji: '👍' })).rejects.toMatchObject(archived)
    state.actor = 'admin-001'
    await expect(call('../../server/api/messages/[id]/pin.put', 'PUT')).rejects.toMatchObject(archived)
    await expect(setMessagePin(state.env!, await member('admin-001'), 'm-001', { pinned: true })).rejects.toMatchObject(archived)
    state.id = 'random-001'
    state.body = { messageId: 'm-002' }
    await expect(call('../../server/api/channels/[id]/threads.post', 'POST')).rejects.toMatchObject(archived)
    await expect(call('../../server/api/channels/[id]/attachments.post', 'POST')).rejects.toMatchObject(archived)
    state.body = { name: 'renamed' }
    await expect(call('../../server/api/channels/[id].patch', 'PATCH')).rejects.toMatchObject(archived)
    state.body = { categoryId: null, beforeId: null }
    await expect(call('../../server/api/channels/[id]/position.put', 'PUT')).rejects.toMatchObject(archived)
    expect(sqlite.prepare('SELECT count(*) AS n FROM message_reactions').get()).toEqual({ n: 0 })
    expect(sqlite.prepare('SELECT count(*) AS n FROM message_pins').get()).toEqual({ n: 0 })
    expect(sqlite.prepare("SELECT name FROM channels WHERE id='random-001'").get()).toEqual({ name: 'random' })
  })

  it('rejects socket sends, edits, Agent posts and Live starts in the Channel Durable Object', async () => {
    const room = channelDo('random-001')
    const authz = await room.loadAuthz('member-001')
    expect(authz).toMatchObject({ archived: true })
    expect(authz!.perms & Permission.sendMessages).toBe(0)
    const ws = { send: vi.fn() }
    const sock = { userId: 'member-001', user: user('member-001') }
    await room.onCreate(ws, sock, authz, { t: 'message.create', content: 'hi', clientId: 'c1' })
    expect(JSON.parse(ws.send.mock.calls[0]![0])).toMatchObject({ t: 'error', code: 'channel_archived', clientId: 'c1' })
    await room.onUpdate(ws, sock, authz, { t: 'message.update', id: 'm-001', content: 'edited' })
    expect(JSON.parse(ws.send.mock.calls[1]![0])).toMatchObject({ t: 'error', code: 'channel_archived' })
    await expect(room.joinLiveNow(user('member-001'), {})).resolves.toMatchObject({ ok: false, code: 'channel_archived' })
    const thread = channelDo('thread-001')
    expect(await thread.loadAuthz('agent-001')).toMatchObject({ archived: true })
    await expect(thread.postAgentMessage({ agentId: 'agent-001', content: 'Answer' })).rejects.toThrow(/archived/u)
    expect(sqlite.prepare("SELECT content FROM messages WHERE id='m-001'").get()).toEqual({ content: 'Quarterly roadmap notes' })
  })

  it('keeps history readable at its link and lets authors remove their words', async () => {
    state.actor = 'member-001'
    await expect(readChannelMessages(state.env!, await member('member-001'), 'random-001')).resolves.toMatchObject({ messages: [{ id: 'm-001' }, { id: 'm-002' }] })
    const response = await call('../../server/api/channels/[id].get', 'GET') as { channel: { archivedAt: string | null, permissions: number } }
    expect(response.channel.archivedAt).toBe('2026-10-24T00:00:00Z')
    expect(response.channel.permissions & (Permission.sendMessages | Permission.startLive)).toBe(0)
    const thread = await requireChannelAccessForMember(state.env!, member('member-001'), 'thread-001')
    expect(thread.archivedAt).toBe('2026-10-24T00:00:00Z')
    await expect(deleteChannelMessage(state.env!, await member('member-001'), 'm-001')).resolves.toEqual({ ok: true })
  })

  it('blocks a Schedule that posts there until the channel is restored', async () => {
    sqlite.exec(`INSERT INTO agent_schedules(id,principal_id,created_by,channel_id,kind,content,first_at,timezone,recurrence,next_at,status,authorization_json,created_at)
      VALUES('schedule-001','member-001','member-001','random-001','reminder','Standup','2026-10-24','UTC','once','2026-10-24','active','{}','2026-10-23')`)
    const item = { id: 'schedule-001', nextAt: '2026-10-24', recurrence: 'once' } as unknown as Schedule
    const error = await sendChannelMessage(state.env!, await member('member-001'), 'random-001', { content: 'Standup' }, schedule).catch((caught: unknown) => caught)
    await expect(recordScheduleFailure(state.env!, item, error)).resolves.toBeNull()
    expect(sqlite.prepare("SELECT status, last_error_code FROM agent_schedules WHERE id='schedule-001'").get()).toEqual({ status: 'blocked', last_error_code: 'channel_archived' })
  })
})

describe('archived channels leave navigation', () => {
  it('hides them from the channel list, MCP list_channels and the Inbox, and restore returns them', async () => {
    markArchived()
    state.actor = 'member-001'
    const list = async () => (await call('../../server/api/servers/[id]/channels.get', 'GET') as { channels: Array<{ id: string }> }).channels.map(channel => channel.id)
    state.id = serverId
    expect(await list()).toEqual(['general-001'])
    const mcp = await listMessageChannels(state.env!, await member('member-001'))
    expect(mcp.channels.map(channel => channel.id)).not.toContain('random-001')
    expect(mcp.channels.map(channel => channel.id)).not.toContain('thread-001')
    expect((await loadInbox(state.env!, await member('member-001'))).mentions).toEqual([])

    sqlite.exec("UPDATE channels SET archived_at=NULL, archived_by=NULL WHERE id='random-001'")
    expect(await list()).toEqual(['general-001', 'random-001'])
    expect((await listMessageChannels(state.env!, await member('member-001'))).channels.map(channel => channel.id)).toContain('random-001')
    expect((await loadInbox(state.env!, await member('member-001'))).mentions).toMatchObject([{ messageId: 'm-002' }])
  })

  it('lists archived channels for managers in Server settings', async () => {
    markArchived()
    markArchived('secret-001')
    state.id = serverId
    const listed = await call('../../server/api/servers/[id]/channels/archived.get', 'GET') as { channels: Array<{ id: string, archivedBy: { id: string } | null }> }
    expect(listed.channels.map(channel => channel.id).sort()).toEqual(['random-001', 'secret-001'])
    expect(listed.channels[0]!.archivedBy).toMatchObject({ id: 'admin-001' })
    state.actor = 'member-001'
    await expect(call('../../server/api/servers/[id]/channels/archived.get', 'GET')).rejects.toMatchObject({ statusCode: 403 })
  })

  it('keeps archived history searchable and marks those hits archived', async () => {
    markArchived()
    const result = await searchChannelMessages(state.env!, await member('member-001'), { q: 'roadmap' })
    expect(result.hits.map(hit => hit.id).sort()).toEqual(['m-001', 'm-002', 't-001'])
    expect(result.hits.every(hit => hit.channel.archived === true)).toBe(true)
  })
})
