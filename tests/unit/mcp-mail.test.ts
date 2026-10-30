import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { INIT_SQL } from '../../server/utils/db'
import { authenticateMcpRequest } from '../../server/utils/mcp-access'
import { mcpConsentSubjects } from '../../server/utils/mcp-oauth'
import { resolveMcpPrincipal } from '../../server/utils/mcp-principal'
import { serveMcpRequest } from '../../server/utils/mcp-server'
import {
  listMemberMailboxes, listMemberMailThreads, markMemberMailThreadRead, moveMemberMailThread, readMemberMailThread, requireMailMember,
} from '../../server/utils/mail-service'
import { MCP_DEFAULT_TOKEN_SCOPES, MCP_SCOPES, type McpScope } from '../../shared/mcp'
import { Permission } from '../../shared/permissions'
import type { L4Env } from '../../workers/env'
import { mailboxGrantsSql } from '../helpers/grants'

const serverId = '00000000-0000-4000-8000-000000000001'
const agentId = '00000000-0000-4000-8000-000000000002'
const mailPerms = Permission.mcpConnect | Permission.readMail | Permission.sendMail
let sqlite: DatabaseSync
let env: L4Env
let pending: Promise<unknown>[]
let notifyMailChanged: ReturnType<typeof vi.fn>

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

const grants: Array<[string, string, string]> = [
  ['support-box', 'owner-user', 'manage'], ['support-box', 'sender-user', 'send'], ['support-box', 'reader-user', 'read'],
  ['support-box', 'nomail-user', 'read'], ['support-box', agentId, 'send'], ['sales-box', 'sender-user', 'read'], ['off-box', 'sender-user', 'send'],
]

beforeEach(() => {
  pending = []
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec('PRAGMA foreign_keys=ON')
  sqlite.exec(INIT_SQL)
  sqlite.exec(`
    INSERT INTO server_identity(singleton,id) VALUES (1,'${serverId}');
    INSERT INTO roles(id,key,name,permissions_bitmask) VALUES ('owner-role','owner','Owner',0),
      ('mail-role','custom:mail','Mail',${mailPerms}),('reader-role','custom:reader','Reader',${Permission.mcpConnect | Permission.readMail}),
      ('nomail-role','custom:nomail','No mail',${Permission.mcpConnect});
    INSERT INTO users(id,kind,display_name,status,role_id,joined_at) VALUES
      ('owner-user','human','Owner','active','owner-role','2026-10-21'),
      ('sender-user','human','Sender','active','mail-role','2026-10-21'),
      ('reader-user','human','Reader','active','reader-role','2026-10-21'),
      ('nomail-user','human','No mail','active','nomail-role','2026-10-21'),
      ('outsider-user','human','Outsider','active','mail-role','2026-10-21'),
      ('${agentId}','agent','Mail Agent','active','mail-role','2026-10-21');
    INSERT INTO users(id,kind,display_name,status,role_id) VALUES ('mail-external','human','Email','removed',NULL);
    INSERT INTO server(id,name,owner_id) VALUES ('${serverId}','MCP mail test','owner-user');
    INSERT INTO agents(user_id,created_by) VALUES ('${agentId}','owner-user');
    INSERT INTO email_domains(id,zone_id,domain,app_hostname) VALUES ('domain-1','zone-1','example.com','community.example.com');
    INSERT INTO channels(id,name,type,visibility) VALUES ('support-box','support@example.com','text','private'),
      ('sales-box','sales@example.com','text','private'),('off-box','off@example.com','text','private'),('public-chat','General','text','server');
    INSERT INTO email_mailboxes(channel_id,domain_id,local_part,display_name,enabled) VALUES
      ('support-box','domain-1','support','Support',1),('sales-box','domain-1','sales','Sales',1),('off-box','domain-1','off','Off',0);
  `)
  for (const [channel, user, permission] of grants) {
    sqlite.prepare("INSERT INTO channel_members(channel_id,user_id,joined_at) VALUES (?,?,'2026-10-21')").run(channel, user)
    sqlite.exec(mailboxGrantsSql([channel, user, permission]))
  }
  thread('thread-0001', 'support-box', 'Refund request', '01-root', '2026-10-22T10:00:00Z',
    '<html><body><p>Please refund <b>order 42</b>.</p><script>steal()</script><img src="https://tracker.example/x.gif"></body></html>')
  sqlite.exec(`
    INSERT INTO messages(id,channel_id,author_id,content,created_at) VALUES
      ('02-reply','thread-0001','sender-user','We are on it.','2026-10-22T11:00:00Z'),
      ('03-note','thread-0001','sender-user','Internal: check the order first','2026-10-22T11:30:00Z');
    INSERT INTO email_messages(message_id,thread_channel_id,mailbox_channel_id,direction,from_address,from_name,to_json,bcc_json,delivery_status,created_at)
      VALUES ('02-reply','thread-0001','support-box','outbound','support@example.com','Support','["ann@customer.example"]','["boss@example.com"]','sent','2026-10-22T11:00:00Z');
    INSERT INTO attachments(id,message_id,channel_id,uploader_id,r2_key,filename,content_type,size_bytes,created_at)
      VALUES ('file-0001','01-root','support-box','mail-external','mail/private/receipt-key.pdf','receipt.pdf','application/pdf',1200,'2026-10-22');
  `)
  thread('thread-0002', 'support-box', 'Invoice overdue', '04-root', '2026-10-22T12:00:00Z', 'Your invoice is overdue')
  thread('thread-0003', 'support-box', 'Old newsletter', '05-root', '2026-10-21T09:00:00Z', 'Archived news', 'archive')
  thread('thread-0004', 'sales-box', 'Pricing', '06-root', '2026-10-22T08:00:00Z', 'Sales question')
  notifyMailChanged = vi.fn(async () => {})
  env = { DB: d1(sqlite), SERVER_DO: { getByName: () => ({ notifyMailChanged }) } } as unknown as L4Env
})

afterEach(async () => { await Promise.all(pending); sqlite.close() })

function thread(id: string, mailbox: string, subject: string, rootId: string, at: string, content: string, status = 'inbox') {
  sqlite.prepare('INSERT INTO messages(id,channel_id,author_id,content,created_at) VALUES (?,?,?,?,?)').run(rootId, mailbox, 'mail-external', content, at)
  sqlite.prepare("INSERT INTO channels(id,name,type,visibility,parent_id,parent_message_id) VALUES (?,?,'thread','private',?,?)").run(id, subject, mailbox, rootId)
  sqlite.prepare("INSERT INTO email_threads(channel_id,mailbox_channel_id,subject,status,participants_json,last_message_at) VALUES (?,?,?,?,'[\"ann@customer.example\"]',?)")
    .run(id, mailbox, subject, status, at)
  sqlite.prepare(`INSERT INTO email_messages(message_id,thread_channel_id,mailbox_channel_id,direction,from_address,from_name,to_json,raw_r2_key,created_at)
    VALUES (?,?,?,'inbound','ann@customer.example','Ann','["support@example.com"]','mail/raw/secret.eml',?)`).run(rootId, id, mailbox, at)
}

const schedule = (promise: Promise<unknown>) => { pending.push(promise) }
const allMail: McpScope[] = ['mail:read', 'mail:write']
async function principal(subjectId: string, scopes: McpScope[] = allMail, createdBy = subjectId) {
  const resolved = await resolveMcpPrincipal(env, { id: 'oauth-connection', subjectId, createdBy, scopes, clientId: 'codex-client' })
  if (!resolved) throw new Error('principal unavailable')
  return resolved.authorization
}
const reader = async (user: string, scopes?: McpScope[]) => requireMailMember(env, await principal(user, scopes), 'mail:read')
const writer = async (user: string, scopes?: McpScope[]) => requireMailMember(env, await principal(user, scopes), 'mail:write')

describe('MCP mail tools follow Mailbox grants and the email policy', () => {
  it('lists only enabled Mailboxes with a grant, including for the Server Owner', async () => {
    const sender = await listMemberMailboxes(env, await reader('sender-user'))
    expect(sender.mailboxes).toEqual([
      { channelId: 'sales-box', displayName: 'Sales', address: 'sales@example.com', permission: 'read', canSend: false, unreadCount: 1 },
      { channelId: 'support-box', displayName: 'Support', address: 'support@example.com', permission: 'send', canSend: true, unreadCount: 2 },
    ])
    expect((await listMemberMailboxes(env, await reader('reader-user'))).mailboxes).toMatchObject([{ channelId: 'support-box', permission: 'read', canSend: false }])
    // The Owner bypasses the email policy but, like the interface, still needs a grant.
    expect((await listMemberMailboxes(env, await reader('owner-user'))).mailboxes.map(mailbox => mailbox.channelId)).toEqual(['support-box'])
    expect((await listMemberMailboxes(env, await reader('outsider-user'))).mailboxes).toEqual([])
    // A grant without Read email in the Role reveals nothing.
    expect((await listMemberMailboxes(env, await reader('nomail-user'))).mailboxes).toEqual([])
  })

  it('re-checks a revoked grant and a removed email policy on every call', async () => {
    const auth = await principal('reader-user')
    await expect(listMemberMailThreads(env, await requireMailMember(env, auth, 'mail:read'), { mailboxId: 'support-box' })).resolves.toHaveProperty('threads')
    sqlite.exec("DELETE FROM grants WHERE mailbox_id IS NOT NULL AND member_id='reader-user'")
    expect((await listMemberMailboxes(env, await requireMailMember(env, auth, 'mail:read'))).mailboxes).toEqual([])
    await expect(listMemberMailThreads(env, await requireMailMember(env, auth, 'mail:read'), { mailboxId: 'support-box' })).rejects.toMatchObject({ statusCode: 404 })
    await expect(readMemberMailThread(env, await requireMailMember(env, auth, 'mail:read'), 'thread-0001')).rejects.toMatchObject({ statusCode: 404 })

    const sender = await principal('sender-user')
    sqlite.prepare('UPDATE roles SET permissions_bitmask=? WHERE id=?').run(Permission.mcpConnect, 'mail-role')
    await expect(readMemberMailThread(env, await requireMailMember(env, sender, 'mail:read'), 'thread-0001')).rejects.toMatchObject({ statusCode: 404 })
    sqlite.prepare("UPDATE email_mailboxes SET enabled=0 WHERE channel_id='support-box'").run()
    await expect(readMemberMailThread(env, await reader('owner-user'), 'thread-0001')).rejects.toMatchObject({ statusCode: 404 })
  })

  it('requires the Mail scopes; chat scopes and older tokens do not reach these tools', async () => {
    await expect(requireMailMember(env, await principal('sender-user', ['messages:read', 'messages:write']), 'mail:read')).rejects.toThrow('mail:read scope')
    await expect(requireMailMember(env, await principal('sender-user', ['mail:read']), 'mail:write')).rejects.toThrow('mail:write scope')
    // A token stored before Mail scopes existed keeps exactly what it was granted.
    const oldScopes = MCP_SCOPES.filter(scope => !scope.startsWith('mail:'))
    const token = `dfmcp_${'a'.repeat(64)}`
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))), byte => byte.toString(16).padStart(2, '0')).join('')
    sqlite.prepare(`INSERT INTO mcp_access_tokens(id,name,token_hash,token_prefix,scopes_json,subject_id,created_by,created_at,updated_at)
      VALUES ('old-token','Old',?,?,?,'owner-user','owner-user','2026-01-01','2026-01-01')`).run(digest, token.slice(0, 14), JSON.stringify(oldScopes))
    const old = await authenticateMcpRequest(env, new Request('https://server.example/mcp', { headers: { Authorization: `Bearer ${token}` } }))
    expect(old?.scopes).toEqual(oldScopes)
    await expect(requireMailMember(env, old!.authorization, 'mail:read')).rejects.toThrow('mail:read scope')
    expect(MCP_DEFAULT_TOKEN_SCOPES).toEqual(oldScopes)
  })

  it('offers Mail scopes at consent only when the Role has the matching email policy', async () => {
    sqlite.prepare('UPDATE roles SET permissions_bitmask=? WHERE id=?').run(Permission.mcpConnect | Permission.readMail, 'mail-role')
    expect((await mcpConsentSubjects(env, 'sender-user'))[0]?.scopes).toEqual(['messages:read', 'messages:write', 'mail:read'])
    sqlite.prepare('UPDATE roles SET permissions_bitmask=? WHERE id=?').run(mailPerms, 'mail-role')
    expect((await mcpConsentSubjects(env, 'sender-user'))[0]?.scopes).toEqual(['messages:read', 'messages:write', 'mail:read', 'mail:write'])
    expect((await mcpConsentSubjects(env, 'nomail-user'))[0]?.scopes).toEqual(['messages:read', 'messages:write'])
  })

  it('lists folders with search, unread filter and cursor paging', async () => {
    const member = await reader('sender-user')
    const inbox = await listMemberMailThreads(env, member, { mailboxId: 'support-box' })
    expect(inbox.threads.map(item => item.channelId)).toEqual(['thread-0002', 'thread-0001'])
    expect(inbox.threads[1]).toMatchObject({ subject: 'Refund request', preview: 'Internal: check the order first', unread: true })
    const first = await listMemberMailThreads(env, member, { mailboxId: 'support-box', limit: 1 })
    expect(first.threads.map(item => item.channelId)).toEqual(['thread-0002'])
    const second = await listMemberMailThreads(env, member, { mailboxId: 'support-box', limit: 1, cursor: first.nextCursor! })
    expect(second).toMatchObject({ threads: [{ channelId: 'thread-0001' }], nextCursor: null })
    expect((await listMemberMailThreads(env, member, { mailboxId: 'support-box', query: 'ORDER 42' })).threads.map(item => item.channelId)).toEqual(['thread-0001'])
    expect((await listMemberMailThreads(env, member, { mailboxId: 'support-box', query: 'check the order' })).threads.map(item => item.channelId)).toEqual(['thread-0001'])
    expect((await listMemberMailThreads(env, member, { mailboxId: 'support-box', folder: 'archive' })).threads.map(item => item.channelId)).toEqual(['thread-0003'])
    sqlite.exec("INSERT INTO channel_reads(channel_id,user_id,last_read_message_id,updated_at) VALUES ('thread-0002','sender-user','04-root','2026-10-22')")
    expect((await listMemberMailThreads(env, member, { mailboxId: 'support-box', unread: true })).threads.map(item => item.channelId)).toEqual(['thread-0001'])
    // A conversation ID is not a Mailbox, and another Mailbox's search stays there.
    await expect(listMemberMailThreads(env, member, { mailboxId: 'thread-0001' })).rejects.toMatchObject({ statusCode: 404 })
    await expect(listMemberMailThreads(env, member, { mailboxId: 'public-chat' })).rejects.toMatchObject({ statusCode: 404 })
    expect((await listMemberMailThreads(env, member, { mailboxId: 'sales-box', query: 'refund' })).threads).toEqual([])
  })

  it('reads a conversation as text with notes and attachment metadata, without storage keys or marking it read', async () => {
    const page = await readMemberMailThread(env, await reader('reader-user'), 'thread-0001')
    expect(page.thread).toMatchObject({ channelId: 'thread-0001', subject: 'Refund request', unread: true, canSend: false, participants: ['ann@customer.example'] })
    expect(page.messages.map(message => [message.id, message.kind])).toEqual([['01-root', 'email'], ['02-reply', 'email'], ['03-note', 'note']])
    expect(page.messages[0]).toMatchObject({ author: { displayName: 'Ann' }, attachments: [{ id: 'file-0001', filename: 'receipt.pdf', contentType: 'application/pdf', sizeBytes: 1200 }],
      email: { direction: 'inbound', fromAddress: 'ann@customer.example', to: ['support@example.com'] } })
    expect(page.messages[0]!.content).toContain('Please refund order 42.')
    expect(page.messages[0]!.content).not.toMatch(/<|steal|tracker/u)
    expect(page.messages[1]!.email).toMatchObject({ direction: 'outbound', bcc: ['boss@example.com'], deliveryStatus: 'sent' })
    expect(page.messages[2]!.email).toBeNull()
    expect(JSON.stringify(page)).not.toMatch(/r2_key|mail\/raw|receipt-key|\/api\/files/u)
    expect(sqlite.prepare("SELECT count(*) as n FROM channel_reads WHERE user_id='reader-user'").get()?.n).toBe(0)

    const newest = await readMemberMailThread(env, await reader('reader-user'), 'thread-0001', { limit: 2 })
    expect(newest.messages.map(message => message.id)).toEqual(['02-reply', '03-note'])
    const older = await readMemberMailThread(env, await reader('reader-user'), 'thread-0001', { limit: 2, cursor: newest.nextCursor! })
    expect(older).toMatchObject({ messages: [{ id: '01-root' }], nextCursor: null })
    await expect(readMemberMailThread(env, await reader('sender-user'), 'thread-0001', { cursor: '04-root' })).rejects.toMatchObject({ statusCode: 400 })
    await expect(readMemberMailThread(env, await reader('sender-user'), 'support-box')).rejects.toMatchObject({ statusCode: 404 })
    await expect(readMemberMailThread(env, await reader('reader-user'), 'thread-0004')).rejects.toMatchObject({ statusCode: 404 })
  })

  it('marks read and moves conversations only with a Send grant and Send email, as the interface does', async () => {
    await expect(markMemberMailThreadRead(env, await writer('reader-user', allMail), 'thread-0001')).rejects.toMatchObject({ statusCode: 403 })
    await expect(moveMemberMailThread(env, await writer('reader-user', allMail), 'thread-0001', 'archive', schedule)).rejects.toMatchObject({ statusCode: 403 })
    await expect(moveMemberMailThread(env, await writer('sender-user'), 'thread-0004', 'archive', schedule)).rejects.toMatchObject({ statusCode: 403 })

    await expect(markMemberMailThreadRead(env, await writer('sender-user'), 'thread-0001')).resolves.toEqual({ ok: true, lastReadMessageId: '03-note' })
    expect((await readMemberMailThread(env, await reader('sender-user'), 'thread-0001')).thread.unread).toBe(false)
    expect((await readMemberMailThread(env, await reader('reader-user'), 'thread-0001')).thread.unread).toBe(true)

    await expect(moveMemberMailThread(env, await writer('sender-user'), 'thread-0001', 'archive', schedule)).resolves.toEqual({ ok: true, threadId: 'thread-0001', status: 'archive' })
    await Promise.all(pending)
    expect(sqlite.prepare("SELECT status FROM email_threads WHERE channel_id='thread-0001'").get()?.status).toBe('archive')
    expect(notifyMailChanged).toHaveBeenCalledWith({ t: 'mail.changed', mailboxId: 'support-box', threadId: 'thread-0001' }, expect.arrayContaining(['sender-user', 'reader-user']))
    const audit = sqlite.prepare("SELECT actor_id,meta_json FROM audit_log WHERE action='mail_thread.move'").get()!
    expect(audit.actor_id).toBe('sender-user')
    expect(JSON.parse(String(audit.meta_json))).toMatchObject({ status: 'archive', credentialId: 'oauth-connection', clientId: 'codex-client' })
  })

  it('limits an Agent connection to Mailboxes its approving human can also use', async () => {
    const agent = async (scopes = allMail) => requireMailMember(env, await principal(agentId, scopes, 'owner-user'), 'mail:read')
    await expect(readMemberMailThread(env, await agent(), 'thread-0001')).resolves.toHaveProperty('thread.channelId', 'thread-0001')
    sqlite.exec("DELETE FROM grants WHERE mailbox_id IS NOT NULL AND member_id='owner-user'")
    await expect(readMemberMailThread(env, await agent(), 'thread-0001')).rejects.toMatchObject({ statusCode: 404 })
    expect((await listMemberMailboxes(env, await agent())).mailboxes).toEqual([])
  })

  it('serves the Mail tools over MCP without storage keys', async () => {
    const resolved = await resolveMcpPrincipal(env, { id: 'token', subjectId: 'sender-user', createdBy: 'sender-user', scopes: allMail })
    const callTool = async (name: string, args: Record<string, unknown>) => {
      const response = await serveMcpRequest(new Request('https://localhost/mcp', {
        method: 'POST', headers: { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json', Host: 'localhost' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
      }), { env, principal: resolved!, schedule, origin: 'https://localhost' })
      const body = await response.text()
      return JSON.parse((body.startsWith('event:') ? body.split('\ndata: ')[1]! : body).trim()) as { result: { content: Array<{ text: string }>; isError?: boolean } }
    }
    const mailboxes = await callTool('list_mailboxes', {})
    expect(JSON.parse(mailboxes.result.content[0]!.text).mailboxes).toHaveLength(2)
    const read = await callTool('read_mail_thread', { threadId: 'thread-0001' })
    expect(read.result.isError).toBeFalsy()
    expect(read.result.content[0]!.text).toContain('receipt.pdf')
    expect(read.result.content[0]!.text).not.toMatch(/R2Key|r2_key|mail\/raw|receipt-key/u)
    const searched = await callTool('list_mail_threads', { mailboxId: 'support-box', query: 'invoice' })
    expect(JSON.parse(searched.result.content[0]!.text).threads.map((item: { channelId: string }) => item.channelId)).toEqual(['thread-0002'])
  })
})
