import { requireChannelAccessForMember, requireMemberForUser } from '../../server/utils/channel-access'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { INIT_SQL } from '../../server/utils/db'
import { ALL_PERMISSIONS, Permission } from '../../shared/permissions'
import type { AuthorizationContext } from '../../shared/authorization'
import type { McpScope } from '../../shared/mcp'
import type { L4Env } from '../../workers/env'
import {
  deleteChannelMessage, editChannelMessage, listChannelThreads, listMessageChannels, listMessageMembers, openDirectMessage,
  readChannelMessages, requireMessageMember, searchChannelMessages, sendChannelMessage, setMessagePin, setMessageReaction,
} from '../../server/utils/message-service'
import { SEARCH_MESSAGES_SQL } from '../../server/utils/message-search'
import { channelOverrideSql, mailboxGrantsSql } from '../helpers/grants'

const serverId = '00000000-0000-4000-8000-000000000001'
const agentId = '00000000-0000-4000-8000-000000000002'
const recipientId = '00000000-0000-4000-8000-000000000004'
let sqlite: DatabaseSync
let env: L4Env
let pending: Promise<unknown>[]
let receiveMessage: ReturnType<typeof vi.fn>
let fanout: ReturnType<typeof vi.fn>

function d1(database: DatabaseSync): D1Database {
  return {
    prepare(sql: string) {
      let values: SQLInputValue[] = []
      const statement = {
        bind(...next: SQLInputValue[]) { values = next; return statement },
        async first<T>() { return (database.prepare(sql).get(...values) as T | undefined) ?? null },
        async all<T>() { return { results: database.prepare(sql).all(...values) as T[] } },
        async raw() { const query = database.prepare(sql); query.setReturnArrays(true); return query.all(...values) },
        async run() { return { success: true, meta: database.prepare(sql).run(...values) } },
      }
      return statement
    },
    async batch(statements: Array<{ run: () => Promise<unknown> }>) {
      database.exec('BEGIN')
      try { const values = []; for (const statement of statements) values.push(await statement.run()); database.exec('COMMIT'); return values }
      catch (error) { database.exec('ROLLBACK'); throw error }
    },
  } as unknown as D1Database
}

beforeEach(() => {
  pending = []
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec('PRAGMA foreign_keys=ON')
  sqlite.exec(INIT_SQL)
  sqlite.exec(`
    INSERT INTO server_identity(singleton,id) VALUES (1,'${serverId}');
    INSERT INTO roles(id,key,name,permissions_bitmask) VALUES ('owner-role','owner','Owner',0),('member-role','custom:member','Member',${Permission.mcpConnect | Permission.sendMessages});
    INSERT INTO users(id,kind,display_name,status,role_id,joined_at) VALUES
      ('owner-user','human','Owner','active','owner-role','2026-10-21'),
      ('member-user','human','Member','active','member-role','2026-10-21'),
      ('other-user','human','Other','active','member-role','2026-10-21'),
      ('${recipientId}','human','Recipient','active','member-role','2026-10-21'),
      ('${agentId}','agent','Helper Agent','active','member-role','2026-10-21');
    INSERT INTO server(id,name,owner_id) VALUES ('${serverId}','MCP chat test','owner-user');
    INSERT INTO agents(user_id,created_by) VALUES ('${agentId}','owner-user');
    INSERT INTO channels(id,name,type,visibility,parent_id) VALUES
      ('public-chat','Public','text','server',NULL),
      ('private-chat','Secret','text','private',NULL),
      ('member-dm','dm','dm','private',NULL),
      ('agent-dm','dm','dm','private',NULL);
    INSERT INTO messages(id,channel_id,author_id,content,created_at) VALUES ('thread-root','private-chat','other-user','Private topic','2026-10-21');
    INSERT INTO channels(id,name,type,visibility,parent_id,parent_message_id) VALUES ('private-thread','Thread','thread','server','private-chat','thread-root');
    INSERT INTO channel_members(channel_id,user_id,joined_at) VALUES
      ('private-chat','other-user','2026-10-21'),('member-dm','member-user','2026-10-21'),('member-dm','other-user','2026-10-21'),
      ('agent-dm','member-user','2026-10-21'),('agent-dm','${agentId}','2026-10-21');
  `)
  receiveMessage = vi.fn(async () => 'agent-submission')
  fanout = vi.fn(async () => {})
  env = { DB: d1(sqlite), AI: {}, AGENT_DO: { getByName: () => ({ receiveMessage }) },
    CHANNEL_DO: { getByName: () => ({ fanout }) },
    SERVER_DO: { getByName: () => ({ notifyChannelActivity: async () => {}, notifyChannelRead: async () => {} }) },
  } as unknown as L4Env
})

afterEach(async () => { await Promise.all(pending); sqlite.close() })
const schedule = (promise: Promise<unknown>) => { pending.push(promise) }
function context(id = 'member-user', scopes: McpScope[] = ['messages:read', 'messages:write']): AuthorizationContext {
  return { serverId, principal: { id, kind: 'human', roleId: 'stale-role', roleName: 'stale', permissions: ALL_PERMISSIONS, isOwner: true },
    credential: { kind: 'mcp', id: 'oauth-connection', clientId: 'codex-client', scopes } }
}
const read = async (id = 'public-chat', auth = context(), input = {}) => readChannelMessages(env, await requireMessageMember(env, auth, 'messages:read'), id, input)
const send = async (id = 'public-chat', content = 'Hello', auth = context(), extra = {}) => sendChannelMessage(env, await requireMessageMember(env, auth, 'messages:write'), id, { content, ...extra }, schedule)

describe('MCP messages use the interface channel and send pipeline', () => {
  it('returns the original thread message separately from paginated replies', async () => {
    sqlite.exec(`INSERT INTO messages(id,channel_id,author_id,content,created_at) VALUES
      ('reply-1','private-thread','other-user','First reply','2026-10-22T00:00:00Z'),
      ('reply-2','private-thread','other-user','Latest reply','2026-10-22T00:01:00Z')`)
    const page = await read('private-thread', context('other-user'), { limit: 1 })
    expect(page).toMatchObject({
      rootMessage: { id: 'thread-root', channelId: 'private-chat', content: 'Private topic', author: { id: 'other-user' } },
      messages: [{ id: 'reply-2' }], nextCursor: 'reply-2',
    })
    await expect(read('private-thread', context('member-user'))).rejects.toMatchObject({ statusCode: 404 })
  })

  it('keeps sender, mentions, notification outbox, read receipts, fanout and OAuth audit attribution', async () => {
    sqlite.prepare("INSERT INTO push_subscriptions(id,user_id,endpoint,p256dh,auth,created_at,updated_at) VALUES ('push-1',?,'https://push.example/test','key','auth','2026-10-21','2026-10-21')").run(recipientId)
    const { message } = await send('public-chat', `Hello <@${agentId}> <@${recipientId}>`)
    await Promise.all(pending)
    expect(message.author.id).toBe('member-user')
    expect(new Set(message.mentions)).toEqual(new Set([agentId, recipientId]))
    expect(fanout).toHaveBeenCalledWith(expect.objectContaining({ t: 'message', message }))
    expect(sqlite.prepare('SELECT last_read_message_id FROM channel_reads WHERE user_id=?').get('member-user')?.last_read_message_id).toBe(message.id)
    expect(sqlite.prepare('SELECT count(*) as n FROM notification_outbox').get()?.n).toBeGreaterThan(0)
    const audit = sqlite.prepare("SELECT actor_id,meta_json FROM audit_log WHERE action='message.create'").get()!
    expect(audit.actor_id).toBe('member-user')
    expect(JSON.parse(String(audit.meta_json))).toMatchObject({ credentialId: 'oauth-connection', clientId: 'codex-client', principalKind: 'human' })
    expect(receiveMessage).not.toHaveBeenCalled() // Same management boundary as the interface.
  })

  it('allows a participating Agent to read its own conversation without the human invocation grant', async () => {
    const member = await requireMemberForUser(env, { id: agentId, kind: 'agent', displayName: 'Helper Agent', avatarR2Key: null }, serverId)
    const access = await requireChannelAccessForMember(env, member, 'agent-dm')
    expect(access.user.id).toBe(agentId)
    await expect(requireChannelAccessForMember(env, member, 'private-chat')).rejects.toMatchObject({ statusCode: 404 })
  })

  it('dispatches Agent mentions for an authorized human and preserves the initiating human', async () => {
    const { message } = await send('public-chat', `<@${agentId}> Please reply`, context('owner-user'), { agentMode: 'steer' })
    await Promise.all(pending)
    expect(receiveMessage).toHaveBeenCalledWith(expect.objectContaining({ messageId: message.id, authorId: 'owner-user', channelId: 'public-chat', mode: 'steer' }))
    receiveMessage.mockClear()
    sqlite.exec("UPDATE agents SET status='paused'")
    await send('public-chat', `<@${agentId}> Paused`, context('owner-user'))
    await Promise.all(pending)
    expect(receiveMessage).not.toHaveBeenCalled()
  })

  it('rejects private channels and inherited private threads, including for the Server Owner', async () => {
    for (const channel of ['private-chat', 'private-thread']) for (const user of ['member-user', 'owner-user']) {
      await expect(read(channel, context(user))).rejects.toMatchObject({ statusCode: 404 })
      await expect(send(channel, 'Denied', context(user))).rejects.toMatchObject({ statusCode: 404 })
    }
    sqlite.exec("INSERT INTO channel_members(channel_id,user_id,joined_at) VALUES ('private-chat','member-user','2026-10-21')")
    await expect(send('private-thread')).resolves.toHaveProperty('message.author.id', 'member-user')
    sqlite.exec("DELETE FROM channel_members WHERE channel_id='private-chat' AND user_id='member-user'")
    await expect(read('private-thread')).rejects.toMatchObject({ statusCode: 404 })
  })

  it('does not expose an Agent’s private DM to its MCP token administrator', async () => {
    const auth = context('owner-user')
    auth.principal = { ...auth.principal, id: agentId, kind: 'agent', isOwner: false, permissions: Permission.mcpConnect | Permission.sendMessages }
    auth.delegation = { by: 'owner-user', isOwner: true, permissions: Permission.mcpConnect | Permission.sendMessages }
    const member = await requireMessageMember(env, auth, 'messages:read')
    await expect(readChannelMessages(env, member, 'agent-dm')).rejects.toMatchObject({ statusCode: 404 })
    expect((await listMessageChannels(env, member)).channels.map(channel => channel.id)).not.toContain('agent-dm')
  })

  it('applies channel allow/deny and DM participation instead of requiring a global send grant', async () => {
    sqlite.prepare("UPDATE roles SET permissions_bitmask=? WHERE id='member-role'").run(Permission.mcpConnect)
    await expect(send()).rejects.toMatchObject({ statusCode: 403 })
    sqlite.exec(channelOverrideSql('public-chat', 'member-role', Permission.sendMessages, 0))
    await expect(send()).resolves.toHaveProperty('message.author.id', 'member-user')
    await expect(send('member-dm')).resolves.toHaveProperty('message.author.id', 'member-user')
    sqlite.exec(channelOverrideSql('public-chat', 'member-role', 0, Permission.sendMessages))
    await expect(send()).rejects.toMatchObject({ statusCode: 403 })
    await expect(read()).resolves.toHaveProperty('messages')
    await expect(read('agent-dm')).rejects.toMatchObject({ statusCode: 404 })
  })

  it('allows frozen DM history but denies further sends after a participant is removed', async () => {
    await send('member-dm')
    await Promise.all(pending)
    sqlite.exec("UPDATE users SET status='removed',role_id=NULL,joined_at=NULL WHERE id='other-user'")
    expect((await read('member-dm')).frozen).toBe(true)
    await expect(send('member-dm')).rejects.toMatchObject({ statusCode: 403 })
  })

  it('checks live membership, mcp.connect and each message scope before reading or writing', async () => {
    await expect(read('public-chat', context('member-user', ['messages:write']))).rejects.toThrow('messages:read scope')
    await expect(send('public-chat', 'Denied', context('member-user', ['messages:read']))).rejects.toThrow('messages:write scope')
    await expect(read('public-chat', context('member-user', ['documents:read']))).rejects.toThrow('messages:read scope')
    const foreign = { ...context(), serverId: '00000000-0000-4000-8000-000000000003' }
    await expect(read('public-chat', foreign)).rejects.toMatchObject({ statusCode: 404 })
    sqlite.exec(`UPDATE roles SET permissions_bitmask=${Permission.sendMessages} WHERE id='member-role'`)
    await expect(read()).rejects.toThrow('mcp.connect')
    await expect(send()).rejects.toThrow('mcp.connect')
    sqlite.exec("UPDATE users SET status='removed',role_id=NULL,joined_at=NULL WHERE id='member-user'")
    await expect(read()).rejects.toMatchObject({ statusCode: 403 })
  })

  it('paginates history chronologically without marking it read and redacts deleted bodies', async () => {
    for (const [id, text, deleted] of [['message-1','First',null],['message-2','Hidden','2026-10-21'],['message-3','Last',null]]) {
      sqlite.prepare("INSERT INTO messages(id,channel_id,author_id,content,deleted_at,created_at) VALUES (?,?,?,?,?,'2026-10-21')").run(id, 'public-chat', 'owner-user', text, deleted)
    }
    const page = await read('public-chat', context(), { limit: 2 })
    expect(page.messages.map(x => x.content)).toEqual(['', 'Last'])
    expect(page.nextCursor).toBe('message-2')
    expect((await read('public-chat', context(), { cursor: page.nextCursor })).messages.map(x => x.content)).toEqual(['First'])
    expect(sqlite.prepare('SELECT last_read_message_id FROM channel_reads WHERE user_id=?').get('member-user')?.last_read_message_id).not.toBe('message-004')
    await expect(send('public-chat', '  ')).rejects.toMatchObject({ statusCode: 400 })
    await expect(send('public-chat', 'x'.repeat(2001))).rejects.toThrow()
    sqlite.exec("INSERT INTO messages(id,channel_id,author_id,content,created_at) VALUES ('foreign-message','private-chat','other-user','Private','2026-10-21')")
    await expect(send('public-chat', 'Invalid reply', context(), { replyToId: 'foreign-message' })).rejects.toMatchObject({ statusCode: 400 })
  })

  it('discovers only accessible chats and members with the same Agent visibility as the interface', async () => {
    const member = await requireMessageMember(env, context(), 'messages:read')
    const ids = (await listMessageChannels(env, member)).channels.map(x => x.id)
    expect(ids).toEqual(['public-chat', 'member-dm'])
    const members = await listMessageMembers(env, member)
    expect(members.members.some(x => x.kind === 'agent')).toBe(false)
    const owner = await requireMessageMember(env, context('owner-user'), 'messages:read')
    expect((await listMessageMembers(env, owner, { kind: 'agent' })).members).toEqual([expect.objectContaining({ id: agentId, mentionToken: `<@${agentId}>` })])
    expect((await listMessageChannels(env, owner)).channels.map(x => x.id)).not.toContain('private-chat')
    // HTTP members.get shows Agents to Manage agents too; MCP follows the same rule.
    for (const flag of [Permission.manageAgents, Permission.useAgents]) {
      sqlite.prepare("UPDATE roles SET permissions_bitmask=? WHERE id='member-role'").run(Permission.mcpConnect | Permission.sendMessages | flag)
      const manager = await requireMessageMember(env, context(), 'messages:read')
      expect((await listMessageMembers(env, manager, { kind: 'agent' })).members.map(x => x.id)).toEqual([agentId])
    }
    sqlite.prepare("UPDATE roles SET permissions_bitmask=? WHERE id='member-role'").run(Permission.mcpConnect | Permission.sendMessages)
    const page = await listMessageChannels(env, member, { limit: 1 })
    expect(page.channels.map(x => x.id)).toEqual(['public-chat'])
    expect((await listMessageChannels(env, member, { cursor: page.nextCursor! })).channels.map(x => x.id)).toEqual(['member-dm'])
  })

  it('reports unread state per conversation so a client can catch up in one call', async () => {
    sqlite.exec(`INSERT INTO messages(id,channel_id,author_id,content,created_at) VALUES ('m1','public-chat','other-user','Seen','2026-10-22T10:00:00Z'),
      ('m2','public-chat','other-user','New','2026-10-22T11:00:00Z'),('m3','member-dm','other-user','Read','2026-10-22T12:00:00Z');
      INSERT INTO channel_reads(channel_id,user_id,last_read_message_id,updated_at) VALUES ('public-chat','member-user','m1','2026-10-22'),('member-dm','member-user','m3','2026-10-22');`)
    const { channels } = await listMessageChannels(env, await requireMessageMember(env, context(), 'messages:read'))
    expect(channels.find(channel => channel.id === 'public-chat')).toMatchObject({ unread: true, unreadCount: 1, lastMessageAt: '2026-10-22T11:00:00Z' })
    expect(channels.find(channel => channel.id === 'member-dm')).toMatchObject({ unread: false, unreadCount: 0 })
  })

  it('keeps mailbox reads separate from writes even though MCP uses HTTP POST for both', async () => {
    sqlite.exec(`
      INSERT INTO channels(id,name,type,visibility) VALUES ('mailbox-chat','Inbox','text','server');
      INSERT INTO email_domains(id,zone_id,domain,app_hostname) VALUES ('domain-1','zone-1','example.com','community.example.com');
      INSERT INTO email_mailboxes(channel_id,domain_id,local_part,display_name) VALUES ('mailbox-chat','domain-1','inbox','Inbox');
      ${mailboxGrantsSql(['mailbox-chat', 'member-user', 'read'])}
    `)
    await expect(read('mailbox-chat')).rejects.toMatchObject({ statusCode: 404 })
    sqlite.exec("INSERT INTO roles(id,key,name,permissions_bitmask) VALUES ('mail-only-role','custom:mail-only','Mail only',0); UPDATE users SET role_id='mail-only-role' WHERE id='member-user'")
    sqlite.prepare('INSERT INTO project_policies(id,name,permissions_bitmask) VALUES (?,?,?)').run('mail-reader', 'Mail reader', Permission.readMail | Permission.mcpConnect)
    sqlite.prepare('INSERT INTO role_policies(role_id,policy_id) VALUES (?,?)').run('mail-only-role', 'mail-reader')
    await expect(read('mailbox-chat')).resolves.toHaveProperty('messages')
    await expect(send('mailbox-chat')).rejects.toMatchObject({ statusCode: 403 })
    sqlite.exec(`UPDATE grants SET permissions=${Permission.readMail | Permission.sendMail} WHERE mailbox_id='mailbox-chat'`)
    await expect(send('mailbox-chat')).rejects.toMatchObject({ statusCode: 403 })
    sqlite.prepare('UPDATE project_policies SET permissions_bitmask=? WHERE id=?').run(Permission.readMail | Permission.sendMail | Permission.mcpConnect, 'mail-reader')
    await expect(send('mailbox-chat')).resolves.toHaveProperty('message.author.id', 'member-user')
    sqlite.exec("DELETE FROM grants WHERE mailbox_id='mailbox-chat'")
    await expect(read('mailbox-chat')).rejects.toMatchObject({ statusCode: 404 })
  })
})

describe('Server-wide search and MCP chat actions', () => {
  const member = async (auth = context()) => requireMessageMember(env, auth, 'messages:write')
  function seedSearch() {
    sqlite.exec(`
      INSERT INTO messages(id,channel_id,author_id,content,created_at) VALUES ('public-root','public-chat','other-user','Topic','2026-10-21T00:00:00Z');
      INSERT INTO channels(id,name,type,visibility,parent_id,parent_message_id) VALUES ('public-thread','Plans','thread','server','public-chat','public-root');
      INSERT INTO channels(id,name,type,visibility) VALUES ('mailbox-chat','Inbox','text','server');
      INSERT INTO email_domains(id,zone_id,domain,app_hostname) VALUES ('domain-1','zone-1','example.com','community.example.com');
      INSERT INTO email_mailboxes(channel_id,domain_id,local_part,display_name) VALUES ('mailbox-chat','domain-1','inbox','Inbox');
      ${mailboxGrantsSql(['mailbox-chat', 'member-user', 'send'])}
      INSERT INTO messages(id,channel_id,author_id,content,created_at) VALUES
        ('hit-public','public-chat','other-user','Launch checklist','2026-10-22T00:00:01Z'),
        ('hit-thread','public-thread','other-user','Launch in the thread','2026-10-22T00:00:02Z'),
        ('hit-private','private-chat','other-user','Launch secret','2026-10-22T00:00:03Z'),
        ('hit-private-thread','private-thread','other-user','Launch private reply','2026-10-22T00:00:04Z'),
        ('hit-dm','member-dm','other-user','Launch between us','2026-10-22T00:00:05Z'),
        ('hit-agent','agent-dm','${agentId}','Launch from the agent','2026-10-22T00:00:06Z'),
        ('hit-mail','mailbox-chat','other-user','Launch email','2026-10-22T00:00:07Z');
    `)
  }

  it('searches every readable channel, thread and DM with thread-aware links', async () => {
    seedSearch()
    const result = await searchChannelMessages(env, await member(), { q: 'launch' })
    expect(result.hits.map(hit => hit.id)).toEqual(['hit-dm', 'hit-thread', 'hit-public'])
    expect(result.hits.find(hit => hit.id === 'hit-thread')?.channel).toMatchObject({ title: 'Public', name: 'Plans', path: '/channels/public-chat/threads/public-thread' })
    expect(result.hits.find(hit => hit.id === 'hit-dm')?.channel).toMatchObject({ title: 'Other', path: '/channels/member-dm' })

    const agentAuth = context(agentId)
    agentAuth.principal = { ...agentAuth.principal, kind: 'agent', isOwner: false }
    const agentHits = await searchChannelMessages(env, await member(agentAuth), { q: 'launch' })
    expect(agentHits.hits.find(hit => hit.id === 'hit-agent')?.channel.path).toBe('/agents/agent-dm')
    agentAuth.delegation = { by: 'owner-user', isOwner: true, permissions: Permission.mcpConnect }
    expect((await searchChannelMessages(env, await member(agentAuth), { q: 'launch' })).hits.map(hit => hit.id)).not.toContain('hit-agent')

    sqlite.exec("INSERT INTO channel_members(channel_id,user_id,joined_at) VALUES ('private-chat','member-user','2026-10-21')")
    const scoped = await searchChannelMessages(env, await member(), { q: 'launch', channelId: 'private-chat' })
    expect(scoped.hits.map(hit => hit.id)).toEqual(['hit-private-thread', 'hit-private'])
    const first = await searchChannelMessages(env, await member(), { q: 'launch', limit: 1 })
    expect(first.hits.map(hit => hit.id)).toEqual(['hit-dm'])
    const next = await searchChannelMessages(env, await member(), { q: 'launch', limit: 1, cursor: first.nextCursor })
    expect(next.hits.map(hit => hit.id)).toEqual(['hit-private-thread'])
    await expect(searchChannelMessages(env, await member(), { q: 'launch', cursor: next.nextCursor, channelId: 'public-chat' })).rejects.toMatchObject({ statusCode: 400 })
    await expect(searchChannelMessages(env, await requireMessageMember(env, context('member-user', ['messages:write']), 'messages:write'), { q: 'launch' })).rejects.toThrow('messages:read scope')
  })

  it('searches a conversation together with its threads', () => {
    seedSearch()
    const rows = sqlite.prepare(SEARCH_MESSAGES_SQL).all('"launch"*', 'public-chat', 0, '', '', '', 10) as Array<{ id: string, rootId: string }>
    expect(rows.map(row => row.id)).toEqual(['hit-thread', 'hit-public'])
    expect(rows.every(row => row.rootId === 'public-chat')).toBe(true)
    const thread = sqlite.prepare(SEARCH_MESSAGES_SQL).all('"launch"*', 'public-thread', 0, '', '', '', 10) as Array<{ id: string }>
    expect(thread.map(row => row.id)).toEqual(['hit-thread'])
  })

  it('lists threads of an accessible conversation only', async () => {
    seedSearch()
    const listed = await listChannelThreads(env, await member(), 'public-chat')
    expect(listed.threads).toEqual([expect.objectContaining({ id: 'public-thread', title: 'Plans', replyCount: 1, rootMessage: expect.objectContaining({ id: 'public-root', content: 'Topic' }) })])
    await expect(listChannelThreads(env, await member(), 'private-chat')).rejects.toMatchObject({ statusCode: 404 })
  })

  it('edits and deletes only the caller’s own messages with audit attribution', async () => {
    const { message } = await send('public-chat', 'Draft')
    await expect(editChannelMessage(env, await member(context('other-user')), message.id, { content: 'Hijack' })).rejects.toMatchObject({ statusCode: 403 })
    const edited = await editChannelMessage(env, await member(), message.id, { content: `Final <@${recipientId}>` })
    expect(edited.message).toMatchObject({ content: `Final <@${recipientId}>`, mentions: [recipientId] })
    expect(edited.message.editedAt).toBeTruthy()
    expect(fanout).toHaveBeenCalledWith(expect.objectContaining({ t: 'message.update' }))
    const audit = sqlite.prepare("SELECT actor_id,meta_json FROM audit_log WHERE action='message.update'").get()!
    expect(JSON.parse(String(audit.meta_json))).toMatchObject({ credentialId: 'oauth-connection', mentions: [recipientId] })

    await expect(deleteChannelMessage(env, await member(context('other-user')), message.id)).rejects.toMatchObject({ statusCode: 403 })
    await expect(deleteChannelMessage(env, await member(), message.id)).resolves.toEqual({ ok: true })
    expect(sqlite.prepare('SELECT content,deleted_at FROM messages WHERE id=?').get(message.id)).toMatchObject({ content: '' })
    expect(fanout).toHaveBeenCalledWith({ t: 'message.delete', id: message.id })
    await expect(deleteChannelMessage(env, await member(), message.id)).resolves.toEqual({ ok: true })
    await expect(editChannelMessage(env, await member(), message.id, { content: 'Again' })).rejects.toMatchObject({ statusCode: 409 })
    expect(sqlite.prepare("SELECT count(*) AS n FROM audit_log WHERE action='message.delete'").get()?.n).toBe(1)
  })

  it('reacts idempotently and pins with the interface rules', async () => {
    sqlite.exec("INSERT INTO messages(id,channel_id,author_id,content,created_at) VALUES ('m-public','public-chat','other-user','Hello','2026-10-22'),('m-dm','member-dm','other-user','Hi','2026-10-22')")
    expect(await setMessageReaction(env, await member(), 'm-public', { emoji: '👍' })).toEqual({ op: 'add', changed: true })
    expect(await setMessageReaction(env, await member(), 'm-public', { emoji: '👍' })).toEqual({ op: 'add', changed: false })
    expect(await setMessageReaction(env, await member(), 'm-public', { emoji: '👍', remove: true })).toEqual({ op: 'remove', changed: true })
    await expect(setMessageReaction(env, await member(), 'thread-root', { emoji: '👍' })).rejects.toMatchObject({ statusCode: 404 })
    await expect(setMessagePin(env, await member(), 'm-public', { pinned: true })).rejects.toMatchObject({ statusCode: 403 })
    const pinned = await setMessagePin(env, await member(), 'm-dm', { pinned: true })
    expect(pinned).toMatchObject({ changed: true, pin: { pinnedBy: { id: 'member-user' } } })
    expect(await setMessagePin(env, await member(), 'm-dm', { pinned: false })).toEqual({ pin: null, changed: true })
  })

  it('opens 1:1 DMs like the interface and keeps delegated Agent DMs private', async () => {
    expect((await openDirectMessage(env, await member(), 'other-user')).channel).toMatchObject({ id: 'member-dm', canSend: true })
    await expect(openDirectMessage(env, await member(), agentId)).rejects.toMatchObject({ statusCode: 403 })
    await expect(openDirectMessage(env, await member(), 'member-user')).rejects.toMatchObject({ statusCode: 400 })
    const opened = await openDirectMessage(env, await member(context('owner-user')), recipientId)
    expect(opened.channel.participants.map(user => user.id).sort()).toEqual(['00000000-0000-4000-8000-000000000004', 'owner-user'])
    const auth = context(agentId)
    auth.principal = { ...auth.principal, kind: 'agent', isOwner: false }
    auth.delegation = { by: 'owner-user', isOwner: true, permissions: Permission.mcpConnect }
    await expect(openDirectMessage(env, await member(auth), 'member-user')).rejects.toMatchObject({ statusCode: 403 })
  })
})
