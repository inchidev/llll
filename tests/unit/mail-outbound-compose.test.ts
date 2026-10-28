import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createError } from 'h3'
import { INIT_SQL } from '../../server/utils/db'
import { d1 } from '../helpers/sqlite-d1'
import { blockedMailAttachment, mailAttachmentLimitError, mailAttachmentType, MAIL_OUTBOUND_LIMITS } from '../../shared/mail-attachments'
import { deliverOutboundEmail } from '../../server/utils/mail-outbound'
import type { L4Env } from '../../workers/env'

const state = vi.hoisted(() => ({
  body: {} as Record<string, unknown>,
  channelId: 'support',
  userId: 'owner',
  form: [] as Array<{ name: string; data: Buffer; filename?: string; type?: string }>,
}))
vi.mock('../../server/utils/server-mail', () => ({
  requireMailboxPermission: async (_event: unknown, channelId: string) => {
    const thread = !['support', 'sales'].includes(channelId)
    return { user: { id: state.userId }, serverId: 'server', mailboxId: thread ? 'support' : channelId, channel: { type: thread ? 'thread' : 'text' } }
  },
  requireMailSendLimit: async () => {},
}))

function bucket() {
  const objects = new Map<string, Uint8Array>()
  return {
    objects,
    async put(key: string, value: Uint8Array) { objects.set(key, new Uint8Array(value)) },
    async get(key: string) {
      const bytes = objects.get(key)
      return bytes ? { key, size: bytes.byteLength, httpEtag: '"e"', body: bytes, arrayBuffer: async () => Uint8Array.from(bytes).buffer } : null
    },
    async head(key: string) { return objects.has(key) ? { key, size: objects.get(key)!.byteLength } : null },
    async delete(keys: string | string[]) { for (const key of [keys].flat()) objects.delete(key) },
  }
}

let sqlite: DatabaseSync, env: L4Env, files: ReturnType<typeof bucket>
const send = vi.fn(async (_message: Record<string, unknown>) => ({ messageId: `<sent-${send.mock.calls.length}@example.com>` }))
const pdf = Buffer.from('%PDF-1.7\n%test document\n')
beforeEach(() => {
  send.mockClear()
  state.userId = 'owner'; state.channelId = 'support'
  for (const [name, value] of Object.entries({
    defineEventHandler: (fn: unknown) => fn, getRouterParam: () => state.channelId, readBody: async () => state.body,
    getHeader: (_event: unknown, name: string) => name === 'content-type' && state.form.length ? 'multipart/form-data; boundary=x' : 'application/json',
    readMultipartFormData: async () => state.form, createError,
  })) vi.stubGlobal(name, value)
  sqlite = new DatabaseSync(':memory:'); sqlite.exec(INIT_SQL)
  sqlite.exec(`
    INSERT INTO roles (id, key, name, permissions_bitmask) VALUES ('mail-role', 'custom:mail', 'Mail', 0);
    INSERT INTO users (id, display_name, status, role_id, joined_at) VALUES ('owner', 'Owner', 'active', 'mail-role', '2026-09-01'), ('other', 'Other', 'active', 'mail-role', '2026-09-01'), ('mail-external', 'Email', 'removed', NULL, NULL);
    INSERT INTO server_identity(singleton,id) VALUES(1,'00000000-0000-4000-8000-000000000001');
    INSERT INTO server(id,name,owner_id) VALUES('00000000-0000-4000-8000-000000000001','Mail test','owner');
    INSERT INTO channels (id, name, type, visibility) VALUES ('support', 'support', 'text', 'private'), ('sales', 'sales', 'text', 'private');
    INSERT INTO email_domains (id, zone_id, domain, app_hostname) VALUES ('main', 'zone', 'example.com', 'chat.example.com');
    INSERT INTO email_mailboxes (channel_id, domain_id, local_part, display_name) VALUES ('support', 'main', 'support', 'Support'), ('sales', 'main', 'sales', 'Sales');
  `)
  files = bucket()
  env = { DB: d1(sqlite), FILES: files, MAIL_EMAIL: { send }, SERVER_DO: { getByName: () => ({ notifyMailChanged: async () => {} }) } } as unknown as L4Env
})
afterEach(() => { sqlite.close(); vi.unstubAllGlobals() })
async function call(path: string, channelId = state.channelId) {
  state.channelId = channelId
  const handler = (await import(path)).default
  const background: Promise<unknown>[] = []
  try { return await handler({ method: 'POST', context: { cloudflare: { env, context: { waitUntil: (work: Promise<unknown>) => background.push(work) } } } } as never) }
  finally { await Promise.allSettled(background) }
}
async function upload(data: Buffer, filename: string, type = 'application/pdf') {
  state.form = [{ name: 'file', data, filename, type }]
  try { return (await call('../../server/api/mail/mailboxes/[id]/attachments.post', 'support')).attachment as { id: string; filename: string; contentType: string; sizeBytes: number } }
  finally { state.form = [] }
}

describe('outbound attachment rules', () => {
  it('reads the type from the bytes and name, and keeps active content opaque', () => {
    expect(mailAttachmentType(pdf, 'invoice.pdf', 'text/html')).toBe('application/octet-stream')
    expect(mailAttachmentType(pdf, 'invoice.pdf')).toBe('application/pdf')
    expect(mailAttachmentType(Buffer.from('<svg onload=alert(1)>'), 'logo.svg')).toBe('application/octet-stream')
    expect(mailAttachmentType(Buffer.from('PK\u0003\u0004rest'), 'report.docx')).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document')
    expect(mailAttachmentType(Buffer.from('a,b\n1,2\n'), 'table.csv')).toBe('text/csv')
  })

  it('refuses programs by name and by signature', () => {
    expect(blockedMailAttachment(pdf, 'setup.exe')).toBe(true)
    const pe = new Uint8Array(128); pe.set([0x4d, 0x5a]); pe[0x3c] = 64; pe.set([0x50, 0x45, 0, 0], 64)
    expect(blockedMailAttachment(pe, 'notes.txt')).toBe(true)
    expect(blockedMailAttachment(Buffer.from('MZ is how this note starts'), 'notes.txt')).toBe(false)
    expect(blockedMailAttachment(Buffer.from('\u007fELF....'), 'tool')).toBe(true)
    expect(blockedMailAttachment(pdf, 'invoice.pdf')).toBe(false)
  })

  it('bounds the count and total size', () => {
    expect(mailAttachmentLimitError([{ sizeBytes: MAIL_OUTBOUND_LIMITS.attachmentBytes }])).toBeNull()
    expect(mailAttachmentLimitError([{ sizeBytes: MAIL_OUTBOUND_LIMITS.attachmentBytes }, { sizeBytes: 1 }])).toMatch(/total at most 3 MB/u)
    expect(mailAttachmentLimitError(Array.from({ length: MAIL_OUTBOUND_LIMITS.attachments + 1 }, () => ({ sizeBytes: 1 })))).toMatch(/at most 10 attachments/u)
  })
})

describe('mail uploads', () => {
  it('stores a private upload with a sniffed type, ignoring the browser type', async () => {
    const attachment = await upload(pdf, 'invoice.pdf', 'text/html')
    expect(attachment).toMatchObject({ filename: 'invoice.pdf', contentType: 'application/pdf', sizeBytes: pdf.byteLength })
    expect(sqlite.prepare('SELECT message_id AS m, channel_id AS c, uploader_id AS u FROM attachments').get()).toEqual({ m: null, c: 'support', u: 'owner' })
    expect(files.objects.size).toBe(1)
  })

  it('refuses programs, empty files and files over the limit', async () => {
    await expect(upload(pdf, 'run.bat')).rejects.toMatchObject({ statusCode: 415 })
    await expect(upload(Buffer.alloc(0), 'empty.txt')).rejects.toMatchObject({ statusCode: 400 })
    await expect(upload(Buffer.alloc(MAIL_OUTBOUND_LIMITS.attachmentBytes + 1, 65), 'big.txt')).rejects.toMatchObject({ statusCode: 413 })
    expect(files.objects.size).toBe(0)
  })

  it('explains that attachments need file storage', async () => {
    env = { ...env, FILES: undefined } as unknown as L4Env
    await expect(upload(pdf, 'invoice.pdf')).rejects.toMatchObject({ statusCode: 409, data: { error: { code: 'mail_files_unavailable' } } })
    state.body = { to: ['customer@example.net'], subject: 'Quote', content: 'Attached', attachmentIds: ['anything'] }
    await expect(call('../../server/api/mail/mailboxes/[id]/send.post', 'support')).rejects.toMatchObject({ statusCode: 409 })
    expect(send).not.toHaveBeenCalled()
  })

  it('lets only the uploader remove an unsent upload', async () => {
    const attachment = await upload(pdf, 'invoice.pdf')
    state.body = { attachmentId: attachment.id }
    state.userId = 'other'
    await expect(call('../../server/api/mail/mailboxes/[id]/attachments.delete', 'support')).rejects.toMatchObject({ statusCode: 404 })
    state.userId = 'owner'
    await call('../../server/api/mail/mailboxes/[id]/attachments.delete', 'support')
    expect(sqlite.prepare('SELECT count(*) AS n FROM attachments').get()).toEqual({ n: 0 })
    expect(files.objects.size).toBe(0)
  })
})

describe('sending attachments', () => {
  it('sends a new email with its files and keeps them on the conversation', async () => {
    const first = await upload(pdf, 'invoice.pdf')
    const second = await upload(Buffer.from('plain notes'), 'notes.txt')
    state.body = { to: ['customer@example.net'], subject: 'Quote', content: 'Attached', attachmentIds: [first.id, second.id], clientId: 'client-request-1' }
    const result = await call('../../server/api/mail/mailboxes/[id]/send.post', 'support')
    expect(send.mock.calls[0]![0].attachments).toEqual([
      { filename: 'invoice.pdf', type: 'application/pdf', content: pdf.toString('base64'), disposition: 'attachment' },
      { filename: 'notes.txt', type: 'text/plain', content: Buffer.from('plain notes').toString('base64'), disposition: 'attachment' },
    ])
    expect(result.message.attachments.map((file: { filename: string }) => file.filename)).toEqual(['invoice.pdf', 'notes.txt'])
    expect(sqlite.prepare('SELECT DISTINCT message_id AS m, channel_id AS c FROM attachments').all()).toEqual([{ m: result.message.id, c: 'support' }])
  })

  it('moves reply files into the conversation', async () => {
    state.body = { to: ['customer@example.net'], subject: 'Quote', content: 'Hello' }
    const { threadId } = await call('../../server/api/mail/mailboxes/[id]/send.post', 'support')
    const file = await upload(pdf, 'invoice.pdf')
    state.body = { to: ['customer@example.net'], content: 'Here it is', attachmentIds: [file.id] }
    const { message } = await call('../../server/api/mail/threads/[id]/reply.post', threadId)
    expect(send.mock.calls[1]![0].attachments).toHaveLength(1)
    expect(sqlite.prepare('SELECT message_id AS m, channel_id AS c FROM attachments').get()).toEqual({ m: message.id, c: threadId })
  })

  it('refuses uploads from someone else, another mailbox, or an email already sent', async () => {
    const file = await upload(pdf, 'invoice.pdf')
    state.userId = 'other'
    state.body = { to: ['customer@example.net'], subject: 'Quote', content: 'Attached', attachmentIds: [file.id] }
    await expect(call('../../server/api/mail/mailboxes/[id]/send.post', 'support')).rejects.toMatchObject({ statusCode: 400 })
    state.userId = 'owner'
    await expect(call('../../server/api/mail/mailboxes/[id]/send.post', 'sales')).rejects.toMatchObject({ statusCode: 400 })
    await call('../../server/api/mail/mailboxes/[id]/send.post', 'support')
    state.body = { ...state.body, subject: 'Again' }
    await expect(call('../../server/api/mail/mailboxes/[id]/send.post', 'support')).rejects.toMatchObject({ statusCode: 400 })
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('refuses a set of files over the total limit before anything is sent', async () => {
    const big = Buffer.alloc(MAIL_OUTBOUND_LIMITS.attachmentBytes - 10, 65)
    const ids = [(await upload(big, 'a.txt')).id, (await upload(Buffer.from('more than ten bytes'), 'b.txt')).id]
    state.body = { to: ['customer@example.net'], subject: 'Big', content: 'Files', attachmentIds: ids }
    await expect(call('../../server/api/mail/mailboxes/[id]/send.post', 'support')).rejects.toMatchObject({ statusCode: 413 })
    expect(sqlite.prepare('SELECT count(*) AS n FROM email_messages').get()).toEqual({ n: 0 })
  })

  it('records a clear failure when a stored file disappeared before delivery', async () => {
    const file = await upload(pdf, 'invoice.pdf')
    state.body = { to: ['customer@example.net'], subject: 'Quote', content: 'Attached', attachmentIds: [file.id] }
    files.objects.clear()
    const { message } = await call('../../server/api/mail/mailboxes/[id]/send.post', 'support')
    expect(message.email).toMatchObject({ deliveryStatus: 'failed', deliveryError: 'Attachment invoice.pdf is no longer available' })
    expect(send).not.toHaveBeenCalled()
    files.objects.set('restored', pdf)
    sqlite.prepare("UPDATE attachments SET r2_key = 'restored'").run()
    send.mockClear(); send.mockResolvedValueOnce({ messageId: '<retried@example.com>' })
    await deliverOutboundEmail(env, message.id)
    expect(send).toHaveBeenCalledTimes(1)
  })
})

describe('forwarding attachments', () => {
  beforeEach(() => {
    sqlite.exec(`
      INSERT INTO messages (id, channel_id, author_id, content, created_at) VALUES ('m1', 'support', 'mail-external', 'See attached', '2026-09-28T00:00:00Z'),
        ('m2', 'sales', 'mail-external', 'Other mailbox', '2026-09-28T00:00:00Z');
      INSERT INTO channels (id, name, type, visibility, parent_id, parent_message_id) VALUES ('t1', 'Files', 'thread', 'private', 'support', 'm1'), ('t2', 'Sales', 'thread', 'private', 'sales', 'm2');
      INSERT INTO email_threads (channel_id, mailbox_channel_id, subject, participants_json, last_message_at) VALUES ('t1', 'support', 'Files', '[]', '2026-09-28'), ('t2', 'sales', 'Sales', '[]', '2026-09-28');
      INSERT INTO email_messages (message_id, thread_channel_id, mailbox_channel_id, direction, from_address, delivery_status, created_at) VALUES
        ('m1', 't1', 'support', 'inbound', 'ann@example.net', 'received', '2026-09-28'), ('m2', 't2', 'sales', 'inbound', 'bo@example.net', 'received', '2026-09-28');
      INSERT INTO attachments (id, message_id, channel_id, uploader_id, r2_key, filename, content_type, size_bytes, created_at) VALUES
        ('a1', 'm1', 'support', 'mail-external', 'in/a1', 'contract.pdf', 'application/pdf', 25, '2026-09-28'),
        ('a2', 'm2', 'sales', 'mail-external', 'in/a2', 'secret.pdf', 'application/pdf', 25, '2026-09-28');
    `)
    files.objects.set('in/a1', pdf); files.objects.set('in/a2', pdf)
  })

  it('copies a file from this mailbox into a new private upload', async () => {
    state.body = { forwardAttachmentId: 'a1' }
    const { attachment } = await call('../../server/api/mail/mailboxes/[id]/attachments.post', 'support')
    expect(attachment).toMatchObject({ filename: 'contract.pdf', contentType: 'application/pdf' })
    expect(sqlite.prepare('SELECT uploader_id AS u, message_id AS m FROM attachments WHERE id = ?').get(attachment.id)).toEqual({ u: 'owner', m: null })
  })

  it('never reaches another mailbox or a deleted email', async () => {
    state.body = { forwardAttachmentId: 'a2' }
    await expect(call('../../server/api/mail/mailboxes/[id]/attachments.post', 'support')).rejects.toMatchObject({ statusCode: 404 })
    sqlite.exec("UPDATE messages SET deleted_at = '2026-09-29' WHERE id = 'm1'")
    state.body = { forwardAttachmentId: 'a1' }
    await expect(call('../../server/api/mail/mailboxes/[id]/attachments.post', 'support')).rejects.toMatchObject({ statusCode: 404 })
  })
})

describe('drafts', () => {
  const save = (body: Record<string, unknown>, mailbox = 'support') => { state.body = body; return call('../../server/api/mail/mailboxes/[id]/drafts.put', mailbox) }
  const list = async (mailbox = 'support') => (await call('../../server/api/mail/mailboxes/[id]/drafts.get', mailbox)).drafts as Array<Record<string, unknown>>
  const attachmentIds = () => sqlite.prepare('SELECT id FROM attachments').all().map(row => row.id)

  it('autosaves a new email, keeps unfinished addresses, and updates the same draft', async () => {
    const file = await upload(pdf, 'invoice.pdf')
    const { draft } = await save({ to: ['customer@exa'], subject: 'Quote\nline', content: 'First', attachmentIds: [file.id] })
    expect(draft).toMatchObject({ threadId: null, to: ['customer@exa'], subject: 'Quote line', content: 'First', format: 'text' })
    expect(draft.attachments.map((item: { id: string }) => item.id)).toEqual([file.id])
    const { draft: again } = await save({ id: draft.id, to: ['customer@example.net'], subject: 'Quote', content: 'Second', format: 'markdown', attachmentIds: [file.id] })
    expect(again).toMatchObject({ id: draft.id, content: 'Second', format: 'markdown' })
    expect(await list()).toHaveLength(1)
  })

  it('keeps one reply draft per conversation and refuses a conversation from another mailbox', async () => {
    state.body = { to: ['customer@example.net'], subject: 'Quote', content: 'Hello' }
    const { threadId } = await call('../../server/api/mail/mailboxes/[id]/send.post', 'support')
    const first = (await save({ threadId, content: 'Thanks' })).draft
    const second = (await save({ threadId, content: 'Thanks again' })).draft
    expect(second.id).toBe(first.id)
    expect(await list()).toEqual([expect.objectContaining({ threadId, threadSubject: 'Quote', content: 'Thanks again' })])
    await expect(save({ threadId, content: 'Wrong mailbox' }, 'sales')).rejects.toMatchObject({ statusCode: 404 })
    await expect(save({ id: first.id, content: 'No conversation' })).rejects.toMatchObject({ statusCode: 409 })
  })

  it('is private to its author and drops files that are not theirs', async () => {
    const file = await upload(pdf, 'invoice.pdf')
    const { draft } = await save({ subject: 'Private', content: 'Mine' })
    state.userId = 'other'
    expect(await list()).toEqual([])
    await expect(save({ id: draft.id, content: 'Taken over' })).rejects.toMatchObject({ statusCode: 404 })
    state.body = { draftId: draft.id }
    await expect(call('../../server/api/mail/mailboxes/[id]/drafts.delete', 'support')).rejects.toMatchObject({ statusCode: 404 })
    const { draft: theirs } = await save({ content: 'Using your file', attachmentIds: [file.id] })
    expect(theirs.attachments).toEqual([])
    state.userId = 'owner'
    expect(await list()).toEqual([expect.objectContaining({ id: draft.id, content: 'Mine' })])
  })

  it('sends from a draft, removing the draft and any file left off the email', async () => {
    const kept = await upload(pdf, 'invoice.pdf')
    const dropped = await upload(Buffer.from('old notes'), 'notes.txt')
    const { draft } = await save({ to: ['customer@example.net'], subject: 'Quote', content: 'Attached', attachmentIds: [kept.id, dropped.id] })
    state.body = { to: ['customer@example.net'], subject: 'Quote', content: 'Attached', attachmentIds: [kept.id], draftId: draft.id }
    const { message } = await call('../../server/api/mail/mailboxes/[id]/send.post', 'support')
    expect(await list()).toEqual([])
    expect(sqlite.prepare('SELECT id, message_id AS m FROM attachments').all()).toEqual([{ id: kept.id, m: message.id }])
  })

  it('sends a reply from its draft', async () => {
    state.body = { to: ['customer@example.net'], subject: 'Quote', content: 'Hello' }
    const { threadId } = await call('../../server/api/mail/mailboxes/[id]/send.post', 'support')
    const { draft } = await save({ threadId, to: ['customer@example.net'], content: 'Reply text' })
    state.body = { to: ['customer@example.net'], content: 'Reply text', draftId: draft.id }
    await call('../../server/api/mail/threads/[id]/reply.post', threadId)
    expect(await list()).toEqual([])
  })

  it('discards a draft with its uploads, and leaves stale uploads on drafts alone', async () => {
    const onDraft = await upload(pdf, 'invoice.pdf')
    const loose = await upload(Buffer.from('forgotten'), 'loose.txt')
    const { draft } = await save({ content: 'Later', attachmentIds: [onDraft.id] })
    sqlite.prepare("UPDATE attachments SET created_at = '2026-01-01T00:00:00.000Z'").run()
    await upload(Buffer.from('fresh'), 'fresh.txt')
    expect(attachmentIds()).not.toContain(loose.id)
    expect(attachmentIds()).toContain(onDraft.id)
    state.body = { draftId: draft.id }
    await call('../../server/api/mail/mailboxes/[id]/drafts.delete', 'support')
    expect(await list()).toEqual([])
    expect(attachmentIds()).not.toContain(onDraft.id)
  })

  it('goes with its mailbox', async () => {
    await save({ content: 'Draft' })
    sqlite.exec("DELETE FROM channels WHERE id = 'support'")
    expect(sqlite.prepare('SELECT count(*) AS n FROM mail_drafts').get()).toEqual({ n: 0 })
  })
})

describe('formatted email', () => {
  it('sends sanitized HTML with a text alternative and shows the text in the conversation', async () => {
    state.body = { to: ['customer@example.net'], subject: 'Quote', content: 'Hi **Ann**\n\n<script>x</script> [terms](https://example.com/terms)', format: 'markdown' }
    const { message, thread } = await call('../../server/api/mail/mailboxes/[id]/send.post', 'support')
    const sent = send.mock.calls[0]![0] as { html: string; text: string }
    expect(sent.html).toContain('<p>Hi <strong>Ann</strong></p>')
    expect(sent.html).toContain('&lt;script&gt;x&lt;/script&gt;')
    expect(sent.html).not.toContain('<script>')
    expect(sent.text).toBe('Hi Ann\n\n<script>x</script> terms [https://example.com/terms]')
    expect(message.content).toBe(sent.text)
    expect(message.email.format).toBe('markdown')
    expect(thread.preview).toBe(sent.text)
    expect(sqlite.prepare('SELECT content FROM messages').get()).toEqual({ content: state.body.content })
  })

  it('keeps plain text mail as typed, without an HTML part', async () => {
    state.body = { to: ['customer@example.net'], subject: 'Plain', content: 'Use **stars** and <b>tags</b> literally' }
    const { message } = await call('../../server/api/mail/mailboxes/[id]/send.post', 'support')
    expect(send.mock.calls[0]![0]).not.toHaveProperty('html')
    expect(send.mock.calls[0]![0].text).toBe(state.body.content)
    expect(message.content).toBe(state.body.content)
  })

  it('formats a reply the same way', async () => {
    state.body = { to: ['customer@example.net'], subject: 'Quote', content: 'Hello' }
    const { threadId } = await call('../../server/api/mail/mailboxes/[id]/send.post', 'support')
    state.body = { to: ['customer@example.net'], content: '- one\n- two', format: 'markdown' }
    await call('../../server/api/mail/threads/[id]/reply.post', threadId)
    expect(send.mock.calls[1]![0]).toMatchObject({ text: ' * one\n * two', html: expect.stringContaining('<ul><li>one</li><li>two</li></ul>') })
  })
})
