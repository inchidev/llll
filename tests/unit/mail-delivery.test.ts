import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDb, INIT_SQL } from '../../server/utils/db'
import { deliverOutboundEmail, replyRecipients, replyThreading } from '../../server/utils/mail-outbound'
import { listMailThreads } from '../../server/utils/mail-threads'
import { hydrateMailMessages } from '../../server/utils/mail-data'
import { messages } from '../../drizzle/schema'
import { MAIL_LIMITS } from '../../shared/mail'
import type { L4Env } from '../../workers/env'
import { ingestServerEmail } from '../../workers/mail-ingress'

let sqlite: DatabaseSync
let files: Map<string, unknown>
let notified: Array<{ mailboxId: string; threadId: string | null }>
let env: L4Env

function d1(database: DatabaseSync): D1Database {
  const statement = (sql: string, values: unknown[] = []) => ({
    sql,
    values,
    bind: (...next: unknown[]) => statement(sql, next),
    async first<T>() { return (database.prepare(sql).get(...values as never[]) as T | undefined) ?? null },
    async all<T>() { return { results: database.prepare(sql).all(...values as never[]) as T[] } },
    async run() { return { meta: { changes: Number(database.prepare(sql).run(...values as never[]).changes) } } },
    async raw() { return database.prepare(sql).all(...values as never[]).map(row => Object.values(row as object)) },
  })
  return {
    prepare: (sql: string) => statement(sql),
    async batch(statements: Array<ReturnType<typeof statement>>) {
      database.exec('BEGIN')
      try {
        const results = statements.map(item => ({ meta: { changes: Number(database.prepare(item.sql).run(...item.values as never[]).changes) } }))
        database.exec('COMMIT')
        return results
      }
      catch (error) {
        database.exec('ROLLBACK')
        throw error
      }
    },
  } as unknown as D1Database
}

function stream(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text)
  return new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close() } })
}

function email(input: { id: string; to: string; subject?: string; from?: string; replyTo?: string; cc?: string; inReplyTo?: string; body?: string; attachments?: Array<{ name: string; bytes: number }> }) {
  const headers = [
    `From: Customer <${input.from ?? 'customer@example.net'}>`,
    `To: ${input.to}`,
    ...(input.replyTo ? [`Reply-To: ${input.replyTo}`] : []),
    ...(input.cc ? [`Cc: ${input.cc}`] : []),
    `Subject: ${input.subject ?? 'Help'}`,
    `Message-ID: ${input.id}`,
    ...(input.inReplyTo ? [`In-Reply-To: ${input.inReplyTo}`, `References: ${input.inReplyTo}`] : []),
    'MIME-Version: 1.0',
  ]
  if (!input.attachments?.length) return [...headers, 'Content-Type: text/plain', '', input.body ?? 'Hello'].join('\r\n')
  const parts = input.attachments.map(file => [
    '--b',
    'Content-Type: application/octet-stream',
    `Content-Disposition: attachment; filename="${file.name}"`,
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.alloc(file.bytes, 1).toString('base64'),
  ].join('\r\n'))
  return [...headers, 'Content-Type: multipart/mixed; boundary="b"', '', '--b', 'Content-Type: text/plain', '', input.body ?? 'Hello', ...parts, '--b--'].join('\r\n')
}

function receive(raw: string, to: string, rawSize?: number) {
  return ingestServerEmail({ from: 'customer@example.net', to, raw: stream(raw), rawSize }, env)
}

function threadsIn(mailboxId: string) {
  return sqlite.prepare('SELECT channel_id as id, participants_json as participants FROM email_threads WHERE mailbox_channel_id = ? ORDER BY created_at').all(mailboxId) as Array<{ id: string; participants: string }>
}

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec(INIT_SQL)
  sqlite.exec(`
    INSERT INTO roles (id, key, name, permissions_bitmask) VALUES ('member', 'member', 'Member', 0);
    INSERT INTO users (id, display_name, status, role_id, joined_at) VALUES ('owner', 'Owner', 'active', 'member', '2026-09-01T00:00:00.000Z'), ('mail-external', 'Email', 'removed', NULL, NULL);
    INSERT INTO server_identity(singleton,id) VALUES(1,'00000000-0000-4000-8000-000000000001');
    INSERT INTO server(id,name,owner_id) VALUES('00000000-0000-4000-8000-000000000001','Mail test','owner');
    INSERT INTO channels (id, name, type, visibility) VALUES ('support', 'support', 'text', 'private'), ('sales', 'sales', 'text', 'private');
    INSERT INTO email_domains (id, zone_id, domain, app_hostname) VALUES ('main', 'zone', 'example.com', 'chat.example.com');
    INSERT INTO email_mailboxes (channel_id, domain_id, local_part, display_name) VALUES ('support', 'main', 'support', 'Support'), ('sales', 'main', 'sales', 'Sales');
    INSERT INTO email_mailbox_access (channel_id, user_id, permission) VALUES ('support', 'owner', 'manage'), ('sales', 'owner', 'manage');
  `)
  files = new Map()
  notified = []
  env = {
    DB: d1(sqlite),
    FILES: {
      put: vi.fn(async (key: string, value: unknown) => { files.set(key, value) }),
      delete: vi.fn(async (keys: string | string[]) => { for (const key of [keys].flat()) files.delete(key) }),
    },
    SERVER_DO: { getByName: () => ({ notifyMailChanged: async (event: { mailboxId: string; threadId: string | null }) => { notified.push(event) } }) },
  } as unknown as L4Env
})

afterEach(() => { sqlite.close(); vi.unstubAllGlobals() })

describe('inbound email', () => {
  it('reads HTML mislabeled as quoted-printable plain text without exposing markup', async () => {
    const body = '<table style=3D"max-width:600px"width=3D100%><tr><td><h2>Welcome to Example!</h2><p>Grow &amp; sell.</p><a href=3D"https://example.com/start">Get started</a></td></tr></table>'
    const raw = email({ id: '<html-text@example.net>', to: 'support@example.com', body })
      .replace('Content-Type: text/plain', 'Content-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: quoted-printable')
    await receive(raw, 'support@example.com')
    const { content } = sqlite.prepare("SELECT content FROM messages WHERE author_id = 'mail-external'").get() as { content: string }
    expect(content).toContain('Welcome to Example!')
    expect(content).toContain('Grow & sell.')
    expect(content).toContain('https://example.com/start')
    expect(content).not.toMatch(/<\/?(?:table|tr|td|h2|p|a)\b/u)
  })

  it('cleans already-stored HTML in message details and inbox previews without rewriting it', async () => {
    await receive(email({ id: '<legacy@example.net>', to: 'support@example.com' }), 'support@example.com')
    const body = `<table style="${'padding:0;'.repeat(50)}"><tr><td><h2>Welcome back!</h2><p>Ready &amp; waiting.</p></td></tr></table>`
    sqlite.prepare("UPDATE messages SET content = ? WHERE author_id = 'mail-external'").run(body)
    const rows = await getDb(env.DB).select().from(messages)
    const detail = await hydrateMailMessages(env, rows, 'owner')
    expect(detail[0]?.content).toContain('Welcome back!')
    expect(detail[0]?.content).toContain('Ready & waiting.')
    expect(detail[0]?.content).not.toContain('<table')
    const inbox = await listMailThreads(env, { mailboxId: 'support', userId: 'owner', folder: 'inbox' })
    expect(inbox.threads[0]?.preview).toContain('Welcome back!')
    expect(inbox.threads[0]?.preview).not.toContain('<table')
    expect(sqlite.prepare("SELECT content FROM messages WHERE author_id = 'mail-external'").get()).toEqual({ content: body })
  })

  it.each(['spam', 'trash', 'archive'])('preserves %s placement when a new reply arrives', async (status) => {
    await receive(email({ id: '<original@example.net>', to: 'support@example.com' }), 'support@example.com')
    sqlite.prepare('UPDATE email_threads SET status = ?').run(status)
    await receive(email({ id: '<followup@example.net>', to: 'support@example.com', inReplyTo: '<original@example.net>' }), 'support@example.com')
    expect(sqlite.prepare('SELECT status FROM email_threads').get()).toEqual({ status: status === 'archive' ? 'inbox' : status })
  })

  it('does not trust an attachment declared to be HTML or SVG', async () => {
    for (const [type, name] of [['text/html', 'attack.html'], ['image/svg+xml', 'attack.svg'], ['image/png', 'disguised.png']]) {
      const raw = email({ id: `<${name}@example.net>`, to: 'support@example.com', attachments: [{ name, bytes: 20 }] })
        .replace('Content-Type: application/octet-stream', `Content-Type: ${type}`)
      await receive(raw, 'support@example.com')
    }
    expect(sqlite.prepare('SELECT content_type FROM attachments').all()).toEqual([
      { content_type: 'application/octet-stream' }, { content_type: 'application/octet-stream' }, { content_type: 'application/octet-stream' },
    ])
  })

  it('delivers one email sent to two mailboxes into both', async () => {
    const raw = email({ id: '<one@example.net>', to: 'support@example.com, sales@example.com' })
    expect(await receive(raw, 'support@example.com')).toEqual({ accepted: true })
    expect(await receive(raw, 'sales@example.com')).toEqual({ accepted: true })
    expect(threadsIn('support')).toHaveLength(1)
    expect(threadsIn('sales')).toHaveLength(1)
    // Delivering the same email to the same mailbox again stores it once.
    expect(await receive(raw, 'support@example.com')).toEqual({ accepted: true })
    expect(threadsIn('support')).toHaveLength(1)
    expect(notified.map(event => event.mailboxId)).toEqual(['support', 'sales'])
  })

  it('stores a message with no Message-ID once per raw body', async () => {
    const raw = [
      'From: Customer <customer@example.net>',
      'To: support@example.com',
      'Subject: Help',
      'MIME-Version: 1.0',
      'Content-Type: text/plain',
      '',
      'Hello',
    ].join('\r\n')
    expect(await receive(raw, 'support@example.com')).toEqual({ accepted: true })
    expect(await receive(raw, 'support@example.com')).toEqual({ accepted: true })
    expect(threadsIn('support')).toHaveLength(1)
    expect(notified).toHaveLength(1)
    const row = sqlite.prepare('SELECT rfc_message_id as rfc, client_request_id as digest FROM email_messages').get() as { rfc: string | null; digest: string }
    expect(row.rfc).toBeNull()
    expect(row.digest).toMatch(/^[0-9a-f]{64}$/u)
    expect(await receive(raw.replace('Hello', 'Hello again'), 'support@example.com')).toEqual({ accepted: true })
    expect(threadsIn('support')).toHaveLength(2)
  })

  it('never threads a reply into another mailbox’s conversation', async () => {
    await receive(email({ id: '<first@example.net>', to: 'support@example.com' }), 'support@example.com')
    // A reply to that email reaches sales, which has never seen the original.
    await receive(email({ id: '<reply@example.net>', to: 'sales@example.com', inReplyTo: '<first@example.net>', subject: 'Re: Help' }), 'sales@example.com')
    const [supportThread] = threadsIn('support')
    const [salesThread] = threadsIn('sales')
    expect(salesThread).toBeDefined()
    expect(salesThread!.id).not.toBe(supportThread!.id)
    expect(sqlite.prepare('SELECT COUNT(*) as count FROM messages WHERE channel_id = ?').get(supportThread!.id)).toEqual({ count: 0 })
  })

  it('uses Reply-To and only includes To/Cc for an explicit Reply all', async () => {
    await receive(email({ id: '<reply-to@example.net>', to: 'support@example.com, colleague@example.net', cc: 'copy@example.net', replyTo: 'replies@example.net' }), 'support@example.com')
    const thread = threadsIn('support')[0]!
    expect(await replyRecipients(env, thread.id, 'support@example.com')).toEqual(['replies@example.net'])
    expect(await replyRecipients(env, thread.id, 'support@example.com', 'all')).toEqual(['replies@example.net', 'colleague@example.net', 'copy@example.net'])
  })

  it('keeps everyone who took part when a reply joins a conversation', async () => {
    await receive(email({ id: '<first@example.net>', to: 'support@example.com', cc: 'colleague@example.net' }), 'support@example.com')
    await receive(email({ id: '<second@example.net>', to: 'support@example.com', from: 'manager@example.net', inReplyTo: '<first@example.net>' }), 'support@example.com')
    const [thread] = threadsIn('support')
    expect(threadsIn('support')).toHaveLength(1)
    expect(JSON.parse(thread!.participants)).toEqual(['customer@example.net', 'colleague@example.net', 'manager@example.net'])
    // Reply all goes to the latest email's people, not everyone ever copied.
    expect(await replyRecipients(env, thread!.id, 'support@example.com')).toEqual(['manager@example.net'])
  })

  it('delivers email without R2 and explicitly reports omitted attachments', async () => {
    env = { ...env, FILES: undefined }
    await receive(email({ id: '<no-r2@example.net>', to: 'support@example.com', attachments: [{ name: 'a.bin', bytes: 10 }] }), 'support@example.com')
    expect(threadsIn('support')).toHaveLength(1)
    expect(sqlite.prepare('SELECT raw_r2_key FROM email_messages').get()).toEqual({ raw_r2_key: null })
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM attachments').get()).toEqual({ count: 0 })
    const message = sqlite.prepare("SELECT content FROM messages WHERE author_id = 'mail-external'").get() as { content: string }
    expect(message.content).toContain('a.bin (file storage is unavailable)')
    expect(files.size).toBe(0)
  })

  it('rejects a message over the size limit before reading it', async () => {
    const result = await receive(email({ id: '<big@example.net>', to: 'support@example.com' }), 'support@example.com', MAIL_LIMITS.rawBytes + 1)
    expect(result).toEqual({ accepted: false, reason: 'Message is too large' })
    expect(files.size).toBe(0)
  })

  it('decodes many joined RFC2047 words while keeping the stored subject bounded', async () => {
    const subject = '=?UTF-8?B?YQ==?= '.repeat(4000).trim()
    expect(await receive(email({ id: '<encoded-words@example.net>', to: 'support@example.com', subject }), 'support@example.com')).toEqual({ accepted: true })
    expect(sqlite.prepare('SELECT subject FROM email_threads').get()).toMatchObject({ subject: 'a'.repeat(500) })
  })

  it('rejects oversized parser headers permanently without storing any mail or files', async () => {
    const raw = email({ id: '<header-limit@example.net>', to: 'support@example.com', subject: 'a'.repeat(2 * 1024 * 1024 + 1) })
    expect(await receive(raw, 'support@example.com')).toEqual({ accepted: false, reason: 'Message could not be parsed or exceeds email parser limits' })
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM email_messages').get()).toMatchObject({ n: 0 })
    expect(files.size).toBe(0)
  })

  it('leaves out attachments over the limits and says so in the message', async () => {
    const attachments = [
      { name: 'huge.bin', bytes: MAIL_LIMITS.attachmentBytes + 1 },
      ...Array.from({ length: MAIL_LIMITS.attachments + 1 }, (_, index) => ({ name: `file-${index}.bin`, bytes: 10 })),
    ]
    await receive(email({ id: '<files@example.net>', to: 'support@example.com', attachments }), 'support@example.com')
    expect(sqlite.prepare('SELECT COUNT(*) as count FROM attachments').get()).toEqual({ count: MAIL_LIMITS.attachments })
    const { content } = sqlite.prepare("SELECT content FROM messages WHERE author_id = 'mail-external'").get() as { content: string }
    expect(content).toMatch(/did not keep these 2 attachments: huge\.bin \(10\.0 MB\), file-20\.bin/u)
  })

  it('removes stored files when the email cannot be saved', async () => {
    sqlite.exec('CREATE TRIGGER fail_mail BEFORE INSERT ON email_messages BEGIN SELECT RAISE(ABORT, \'disk full\'); END')
    await expect(receive(email({ id: '<lost@example.net>', to: 'support@example.com', attachments: [{ name: 'a.bin', bytes: 10 }] }), 'support@example.com')).rejects.toThrow('disk full')
    expect(files.size).toBe(0)
    expect(threadsIn('support')).toHaveLength(0)
  })
})

describe('outbound email', () => {
  function outbound(status: 'pending' | 'failed', attempts: number) {
    sqlite.exec(`
      INSERT INTO messages (id, channel_id, author_id, content, created_at) VALUES ('start', 'support', 'mail-external', 'Help me', '2026-09-28T00:00:00.000Z');
      INSERT INTO channels (id, name, type, visibility, parent_id, parent_message_id) VALUES ('conversation', 'Help', 'thread', 'private', 'support', 'start');
      INSERT INTO messages (id, channel_id, author_id, content, created_at) VALUES ('reply', 'conversation', 'owner', 'Thanks!', '2026-09-29T00:00:00.000Z');
      INSERT INTO email_threads (channel_id, mailbox_channel_id, subject, participants_json, last_message_at) VALUES ('conversation', 'support', 'Help', '["customer@example.net"]', '2026-09-29T00:00:00.000Z');
      INSERT INTO email_messages (message_id, thread_channel_id, mailbox_channel_id, direction, from_address, from_name, to_json, delivery_status, delivery_attempts, created_at)
        VALUES ('reply', 'conversation', 'support', 'outbound', 'support@example.com', 'Support', '["customer@example.net"]', '${status}', ${attempts}, '2026-09-29T00:00:00.000Z');
    `)
  }
  function row() {
    return sqlite.prepare("SELECT delivery_status as status, delivery_attempts as attempts, delivery_error as error, rfc_message_id as rfc FROM email_messages WHERE message_id = 'reply'").get()
  }

  it('sends a reply once and records it as sent', async () => {
    outbound('pending', 0)
    const send = vi.fn(async () => ({ messageId: '<sent@example.com>' }))
    env = { ...env, MAIL_EMAIL: { send } } as unknown as L4Env
    await Promise.all([deliverOutboundEmail(env, 'reply'), deliverOutboundEmail(env, 'reply')])
    await deliverOutboundEmail(env, 'reply')
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0]![0]).toMatchObject({ to: ['customer@example.net'], subject: 'Re: Help', text: 'Thanks!' })
    expect(row()).toEqual({ status: 'sent', attempts: 1, error: null, rfc: '<sent@example.com>' })
  })

  it('records why delivery failed and delivers it on retry', async () => {
    outbound('pending', 0)
    const send = vi.fn()
      .mockRejectedValueOnce(new Error('Recipient\n  rejected'))
      .mockResolvedValueOnce({ messageId: '<retry@example.com>' })
    env = { ...env, MAIL_EMAIL: { send } } as unknown as L4Env
    await deliverOutboundEmail(env, 'reply')
    expect(row()).toEqual({ status: 'failed', attempts: 1, error: 'Recipient rejected', rfc: null })
    await deliverOutboundEmail(env, 'reply')
    expect(row()).toEqual({ status: 'sent', attempts: 2, error: null, rfc: '<retry@example.com>' })
  })

  it('does not confuse REST recipient delivery status with an RFC Message-ID', async () => {
    outbound('pending', 0)
    sqlite.exec(`INSERT INTO messages(id,channel_id,author_id,content,created_at) VALUES('reply2','conversation','owner','Again','2026-09-29');
      INSERT INTO email_messages(message_id,thread_channel_id,mailbox_channel_id,direction,from_address,to_json,delivery_status,created_at)
      VALUES('reply2','conversation','support','outbound','support@example.com','["customer@example.net"]','pending','2026-09-29');`)
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ success: true, result: { delivered: ['customer@example.net'], queued: [], permanent_bounces: [] } })))
    env = { ...env, CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32), CLOUDFLARE_API_TOKEN: 't'.repeat(32) }
    await deliverOutboundEmail(env, 'reply')
    await deliverOutboundEmail(env, 'reply2')
    expect(sqlite.prepare('SELECT delivery_status, rfc_message_id FROM email_messages ORDER BY message_id').all()).toEqual([
      { delivery_status: 'sent', rfc_message_id: null }, { delivery_status: 'sent', rfc_message_id: null },
    ])
  })

  it('does not record a delivered email as failed when saving the receipt fails', async () => {
    outbound('pending', 0)
    sqlite.exec("CREATE TRIGGER fail_receipt BEFORE UPDATE ON email_messages WHEN NEW.delivery_status = 'sent' BEGIN SELECT RAISE(ABORT, 'receipt unavailable'); END")
    env = { ...env, MAIL_EMAIL: { send: vi.fn(async () => ({ messageId: '<sent@example.com>' })) } } as unknown as L4Env
    await expect(deliverOutboundEmail(env, 'reply')).rejects.toThrow('receipt unavailable')
    expect(row()).toMatchObject({ status: 'pending', attempts: 1 })
  })

  it('never places synthetic provider identifiers in reply headers', async () => {
    outbound('pending', 0)
    sqlite.exec("UPDATE email_messages SET rfc_message_id = 'cloudflare:customer@example.net'")
    expect(await replyThreading(env, 'conversation')).toEqual({ inReplyTo: null, references: [] })
  })

  it('recovers an interrupted attempt only after the lease and an explicit resend', async () => {
    outbound('pending', 1)
    const send = vi.fn(async () => ({ messageId: '<resent@example.com>' }))
    env = { ...env, MAIL_EMAIL: { send } } as unknown as L4Env
    const loaded = await hydrateMailMessages(env, await getDb(env.DB).select().from(messages), 'owner')
    expect(loaded.find(message => message.id === 'reply')?.email?.deliveryUncertain).toBe(true)
    await deliverOutboundEmail(env, 'reply')
    expect(send).not.toHaveBeenCalled()
    sqlite.prepare("UPDATE email_messages SET delivery_started_at = ? WHERE message_id = 'reply'").run(new Date().toISOString())
    await deliverOutboundEmail(env, 'reply', { retryUncertain: true })
    expect(send).not.toHaveBeenCalled()
    sqlite.exec("UPDATE email_messages SET delivery_started_at = '2026-09-29' WHERE message_id = 'reply'")
    await Promise.all([deliverOutboundEmail(env, 'reply', { retryUncertain: true }), deliverOutboundEmail(env, 'reply', { retryUncertain: true })])
    expect(send).toHaveBeenCalledTimes(1)
    expect(row()).toMatchObject({ status: 'sent', attempts: 2 })
  })

  it('leaves an email being sent by another request alone', async () => {
    outbound('pending', 1)
    const send = vi.fn()
    env = { ...env, MAIL_EMAIL: { send } } as unknown as L4Env
    await deliverOutboundEmail(env, 'reply')
    expect(send).not.toHaveBeenCalled()
  })
})

describe('mail folders', () => {
  function started(id: string, at: string, status = 'inbox') {
    sqlite.exec(`
      INSERT INTO messages (id, channel_id, author_id, content, created_at) VALUES ('${id}-start', 'support', 'owner', 'Hello from us', '${at}');
      INSERT INTO channels (id, name, type, visibility, parent_id, parent_message_id) VALUES ('${id}', '${id}', 'thread', 'private', 'support', '${id}-start');
      INSERT INTO email_threads (channel_id, mailbox_channel_id, subject, status, participants_json, last_message_at) VALUES ('${id}', 'support', '${id}', '${status}', '["customer@example.net"]', '${at}');
      INSERT INTO email_messages (message_id, thread_channel_id, mailbox_channel_id, direction, from_address, to_json, delivery_status, created_at)
        VALUES ('${id}-start', '${id}', 'support', 'outbound', 'support@example.com', '["customer@example.net"]', 'sent', '${at}');
    `)
  }
  const list = async (folder: 'inbox' | 'sent' | 'archive' | 'trash') =>
    (await listMailThreads(env, { mailboxId: 'support', userId: 'owner', folder })).threads.map(thread => thread.subject)

  it('keeps conversations you started in Sent until someone replies', async () => {
    started('Quote', '2026-09-29T09:00:00.000Z')
    await receive(email({ id: '<question@example.net>', to: 'support@example.com', subject: 'Question' }), 'support@example.com')
    expect(await list('inbox')).toEqual(['Question'])
    expect(await list('sent')).toEqual(['Quote'])

    // The customer replies to the quote; the conversation reaches the Inbox and stays in Sent.
    sqlite.exec("UPDATE email_messages SET rfc_message_id = '<quote@example.com>' WHERE message_id = 'Quote-start'")
    await receive(email({ id: '<answer@example.net>', to: 'support@example.com', subject: 'Re: Quote', inReplyTo: '<quote@example.com>' }), 'support@example.com')
    expect(await list('inbox')).toEqual(['Quote', 'Question'])
    expect(await list('sent')).toEqual(['Quote'])
  })

  it('lists Sent by when you last sent and leaves out Spam and Trash', async () => {
    started('Older', '2026-09-28T09:00:00.000Z', 'archive')
    started('Newer', '2026-09-29T09:00:00.000Z')
    started('Binned', '2026-09-29T10:00:00.000Z', 'trash')
    expect(await list('sent')).toEqual(['Newer', 'Older'])
    expect(await list('archive')).toEqual(['Older'])
    expect(await list('trash')).toEqual(['Binned'])
  })
})
