import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createError } from 'h3'
import { INIT_SQL } from '../../server/utils/db'
import { d1 } from '../helpers/sqlite-d1'
import { forwardedEmail, outboundRecipients } from '../../shared/mail'
import { listMailThreads, mailSearchTerm } from '../../server/utils/mail-threads'
import type { L4Env } from '../../workers/env'

const state = vi.hoisted(() => ({ body: {} as Record<string, unknown>, channelId: 'support', mailboxId: 'support', type: 'text' }))
vi.mock('../../server/utils/server-mail', () => ({
  requireMailboxPermission: async () => ({ user: { id: 'owner' }, mailboxId: state.mailboxId, channel: { type: state.type } }),
  requireMailSendLimit: async () => {},
}))

let sqlite: DatabaseSync, env: L4Env
const send = vi.fn(async (_message: Record<string, unknown>) => ({ messageId: `<sent-${send.mock.calls.length}@example.com>` }))
beforeEach(() => {
  send.mockClear()
  for (const [name, value] of Object.entries({ defineEventHandler: (fn: unknown) => fn, getRouterParam: () => state.channelId, readBody: async () => state.body, createError })) vi.stubGlobal(name, value)
  sqlite = new DatabaseSync(':memory:'); sqlite.exec(INIT_SQL)
  sqlite.exec(`
    INSERT INTO roles (id, key, name, permissions_bitmask) VALUES ('mail-role', 'custom:mail', 'Mail', 0);
    INSERT INTO users (id, display_name, status, role_id, joined_at) VALUES ('owner', 'Owner', 'active', 'mail-role', '2026-09-01'), ('mail-external', 'Email', 'removed', NULL, NULL);
    INSERT INTO server_identity(singleton,id) VALUES(1,'00000000-0000-4000-8000-000000000001');
    INSERT INTO server(id,name,owner_id) VALUES('00000000-0000-4000-8000-000000000001','Mail test','owner');
    INSERT INTO channels (id, name, type, visibility) VALUES ('support', 'support', 'text', 'private');
    INSERT INTO email_domains (id, zone_id, domain, app_hostname) VALUES ('main', 'zone', 'example.com', 'chat.example.com');
    INSERT INTO email_mailboxes (channel_id, domain_id, local_part, display_name) VALUES ('support', 'main', 'support', 'Support');
  `)
  env = { DB: d1(sqlite), MAIL_EMAIL: { send }, SERVER_DO: { getByName: () => ({ notifyMailChanged: async () => {} }) } } as unknown as L4Env
})
afterEach(() => { sqlite.close(); vi.unstubAllGlobals() })
async function call(path: string) {
  const handler = (await import(path)).default
  return handler({ context: { cloudflare: { env, context: { waitUntil: () => {} } } } } as never)
}

describe('Cc and Bcc', () => {
  it('deduplicates across fields and never includes the mailbox itself', () => {
    expect(outboundRecipients({ to: ['A@example.net', 'support@example.com'], cc: ['a@example.net', 'b@example.net'], bcc: ['b@example.net', 'c@example.net'] }, 'Support@Example.com'))
      .toEqual({ to: ['a@example.net'], cc: ['b@example.net'], bcc: ['c@example.net'], total: 3 })
  })

  it('sends a new email with Cc and Bcc, and keeps Bcc out of the conversation participants', async () => {
    state.body = { to: ['customer@example.net'], cc: ['manager@example.net'], bcc: ['audit@example.net'], subject: 'Quote', content: 'Here it is', clientId: 'client-request-1' }
    const result = await call('../../server/api/mail/mailboxes/[id]/send.post')
    expect(send.mock.calls[0]![0]).toMatchObject({ to: ['customer@example.net'], cc: ['manager@example.net'], bcc: ['audit@example.net'], subject: 'Quote' })
    expect(sqlite.prepare('SELECT to_json AS t, cc_json AS c, bcc_json AS b FROM email_messages').get()).toEqual({ t: '["customer@example.net"]', c: '["manager@example.net"]', b: '["audit@example.net"]' })
    expect(sqlite.prepare('SELECT participants_json AS p FROM email_threads').get()).toEqual({ p: '["customer@example.net","manager@example.net"]' })
    expect(result.message.email).toMatchObject({ cc: ['manager@example.net'], bcc: ['audit@example.net'] })
  })

  it('replies with Cc, adding them to the conversation for a later Reply all', async () => {
    state.body = { to: ['customer@example.net'], subject: 'Quote', content: 'Here it is' }
    const { threadId } = await call('../../server/api/mail/mailboxes/[id]/send.post')
    state.channelId = threadId; state.type = 'thread'
    state.body = { to: ['customer@example.net'], cc: ['partner@example.net'], bcc: ['audit@example.net'], content: 'Looping in my partner' }
    try { await call('../../server/api/mail/threads/[id]/reply.post') }
    finally { state.channelId = 'support'; state.type = 'text' }
    expect(send.mock.calls[1]![0]).toMatchObject({ to: ['customer@example.net'], cc: ['partner@example.net'], bcc: ['audit@example.net'], subject: 'Re: Quote' })
    expect(sqlite.prepare('SELECT participants_json AS p FROM email_threads').get()).toEqual({ p: '["customer@example.net","partner@example.net"]' })
  })

  it('omits empty Cc and Bcc from the transport message', async () => {
    state.body = { to: ['customer@example.net'], subject: 'Plain', content: 'Hello' }
    await call('../../server/api/mail/mailboxes/[id]/send.post')
    expect(send.mock.calls[0]![0]).not.toHaveProperty('cc')
    expect(send.mock.calls[0]![0]).not.toHaveProperty('bcc')
  })
})

describe('mail search', () => {
  beforeEach(() => {
    sqlite.exec(`
      INSERT INTO messages (id, channel_id, author_id, content, created_at) VALUES
        ('m1', 'support', 'mail-external', 'Where is my invoice?', '2026-09-28T00:00:00Z'),
        ('m2', 'support', 'mail-external', 'Love the product', '2026-09-28T01:00:00Z');
      INSERT INTO channels (id, name, type, visibility, parent_id, parent_message_id) VALUES
        ('t1', 'Billing', 'thread', 'private', 'support', 'm1'), ('t2', 'Feedback', 'thread', 'private', 'support', 'm2');
      INSERT INTO messages (id, channel_id, author_id, content, created_at) VALUES ('note', 't2', 'owner', 'Internal: escalate to Dana', '2026-09-28T02:00:00Z');
      INSERT INTO email_threads (channel_id, mailbox_channel_id, subject, status, participants_json, last_message_at) VALUES
        ('t1', 'support', 'Billing', 'inbox', '["ann@example.net"]', '2026-09-28T00:00:00Z'),
        ('t2', 'support', 'Feedback', 'inbox', '["bo@example.org"]', '2026-09-28T02:00:00Z');
      INSERT INTO email_messages (message_id, thread_channel_id, mailbox_channel_id, direction, from_address, from_name, to_json, delivery_status, created_at) VALUES
        ('m1', 't1', 'support', 'inbound', 'ann@example.net', 'Ann Accountant', '["support@example.com"]', 'received', '2026-09-28T00:00:00Z'),
        ('m2', 't2', 'support', 'inbound', 'bo@example.org', 'Bo', '["support@example.com"]', 'received', '2026-09-28T01:00:00Z');
    `)
  })
  const search = async (q: string | null) => (await listMailThreads(env, { mailboxId: 'support', userId: 'owner', folder: 'inbox', search: q })).threads.map(thread => thread.subject)

  it.each([
    ['INVOICE', ['Billing']], ['accountant', ['Billing']], ['example.org', ['Feedback']], ['dana', ['Feedback']], ['feedback', ['Feedback']], ['nothing here', []],
  ])('finds %s by subject, sender, address or any message in the conversation', async (q, expected) => {
    expect(await search(q)).toEqual(expected)
  })

  it('lists everything without a search and ignores blank input', async () => {
    expect(await search(null)).toEqual(['Feedback', 'Billing'])
    expect(await search('   ')).toEqual(['Feedback', 'Billing'])
    expect(mailSearchTerm('  Mixed Case  ')).toBe('mixed case')
  })

  it('stays within the requested folder and mailbox', async () => {
    sqlite.exec("UPDATE email_threads SET status='trash' WHERE channel_id='t1'")
    expect(await search('invoice')).toEqual([])
    expect((await listMailThreads(env, { mailboxId: 'other', userId: 'owner', folder: 'inbox', search: 'invoice' })).threads).toEqual([])
  })
})

describe('forward', () => {
  const original = { subject: 'Invoice', fromName: 'Ann', fromAddress: 'ann@example.net', date: '28 Sep 2026, 10:00', to: ['support@example.com'], cc: ['boss@example.net'], content: 'Where is it?' }
  it('quotes the original under a header and prefixes the subject once', () => {
    const forwarded = forwardedEmail(original)
    expect(forwarded.subject).toBe('Fwd: Invoice')
    expect(forwarded.body).toBe('\n\n---------- Forwarded message ----------\nFrom: Ann <ann@example.net>\nDate: 28 Sep 2026, 10:00\nSubject: Invoice\nTo: support@example.com\nCc: boss@example.net\n\nWhere is it?')
    expect(forwardedEmail({ ...original, subject: 'Fwd: Invoice' }).subject).toBe('Fwd: Invoice')
    expect(forwardedEmail({ ...original, fromName: null, cc: [] }).body).not.toContain('Cc:')
  })
})
