import PostalMime, { type Address } from 'postal-mime'
import { newId, nowIso, WORKSPACE_ID } from '../shared/ids'
import { MAIL_EXTERNAL_USER_ID, MAIL_LIMITS, mailAddressList, mergeMailAddresses } from '../shared/mail'
import { plainMailBody } from '../shared/mail-content'
import type { L4Env } from './env'
import { signalMailChanged } from './mail-events'

type MailboxRow = {
  channelId: string
  address: string
}

export type WorkspaceEmailEnvelope = {
  from: string
  to: string
  raw: ReadableStream<Uint8Array>
  /** Size of the raw message when the transport reports it. */
  rawSize?: number
}

export type WorkspaceEmailIngressResult =
  | { accepted: true }
  | { accepted: false, reason: string }

function addressList(values: Address[] | undefined): Array<{ name: string; address: string }> {
  return (values || []).flatMap((value) => {
    if ('group' in value && value.group) return value.group.map(item => ({ name: item.name || '', address: item.address.toLowerCase() }))
    return value.address ? [{ name: value.name || '', address: value.address.toLowerCase() }] : []
  })
}

function referenceIds(inReplyTo?: string, references?: string): string[] {
  const source = `${inReplyTo || ''} ${references || ''}`
  const bracketed = source.match(/<[^>]+>/gu)
  return [...new Set((bracketed?.length ? bracketed : source.split(/\s+/u)).map(value => value.trim()).filter(Boolean))].slice(0, 50)
}

function safeFilename(value: string | null, index: number): string {
  const normalized = (value || `attachment-${index + 1}`).replace(/[\\/\0]/gu, '-').trim()
  return normalized.slice(0, 160) || `attachment-${index + 1}`
}

function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`
}

function copyBytes(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(copy).set(bytes)
  return copy
}

/** Hex SHA-256 of the raw RFC822 bytes. Used only when the message has no Message-ID. */
async function rawSha256(raw: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', copyBytes(raw))
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

/** Reads the raw message, giving up once it passes the size limit. */
async function readRaw(stream: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array | null> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > limit) {
      await reader.cancel().catch(() => {})
      return null
    }
    chunks.push(value)
  }
  const raw = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    raw.set(chunk, offset)
    offset += chunk.byteLength
  }
  return raw
}

/**
 * Stores one inbound email in the mailbox it was addressed to. Duplicate
 * detection and threading only ever look inside that mailbox, so the same email
 * sent to two mailboxes lands in both, and a reply never joins another
 * mailbox's conversation. The same RFC Message-ID is stored once. A message
 * with no Message-ID is stored once per SHA-256 of its raw bytes, in
 * `client_request_id`, so a replay does not add a second copy. That digest is
 * not written as a Message-ID.
 */
export async function ingestWorkspaceEmail(message: WorkspaceEmailEnvelope, env: L4Env): Promise<WorkspaceEmailIngressResult> {
  const recipient = message.to.trim().toLowerCase()
  const mailbox = await env.DB.prepare(
    `SELECT mb.channel_id as channelId, lower(mb.local_part || '@' || d.domain) as address
     FROM email_mailboxes mb JOIN email_domains d ON d.id = mb.domain_id
     WHERE mb.enabled = 1 AND lower(mb.local_part || '@' || d.domain) = ?`,
  ).bind(recipient).first<MailboxRow>()
  if (!mailbox) {
    return { accepted: false, reason: 'Unknown L4 mailbox' }
  }

  if ((message.rawSize ?? 0) > MAIL_LIMITS.rawBytes) return { accepted: false, reason: 'Message is too large' }
  const raw = await readRaw(message.raw, MAIL_LIMITS.rawBytes)
  if (!raw) return { accepted: false, reason: 'Message is too large' }
  const parsed = await PostalMime.parse(raw)
  const rawHash = parsed.messageId ? null : await rawSha256(raw)
  if (parsed.messageId) {
    const duplicate = await env.DB.prepare('SELECT message_id FROM email_messages WHERE mailbox_channel_id = ? AND rfc_message_id = ?')
      .bind(mailbox.channelId, parsed.messageId).first()
    if (duplicate) return { accepted: true }
  }
  else if (rawHash) {
    const duplicate = await env.DB.prepare('SELECT message_id FROM email_messages WHERE mailbox_channel_id = ? AND client_request_id = ?')
      .bind(mailbox.channelId, rawHash).first()
    if (duplicate) return { accepted: true }
  }

  const from = addressList(parsed.from ? [parsed.from] : [])[0] || { name: '', address: message.from.toLowerCase() }
  const to = addressList(parsed.to)
  if (!to.some(item => item.address === recipient)) to.push({ name: '', address: recipient })
  const cc = addressList(parsed.cc)
  const bcc = addressList(parsed.bcc)
  const refs = referenceIds(parsed.inReplyTo, parsed.references)
  let thread: { channelId: string; participantsJson: string } | null = null
  if (refs.length) {
    const placeholders = refs.map(() => '?').join(',')
    thread = await env.DB.prepare(
      `SELECT t.channel_id as channelId, t.participants_json as participantsJson
       FROM email_messages em JOIN email_threads t ON t.channel_id = em.thread_channel_id
       WHERE em.mailbox_channel_id = ? AND t.mailbox_channel_id = ? AND em.rfc_message_id IN (${placeholders})
       ORDER BY em.created_at DESC LIMIT 1`,
    ).bind(mailbox.channelId, mailbox.channelId, ...refs).first<{ channelId: string; participantsJson: string }>()
  }

  const created = nowIso()
  const messageId = newId()
  const subject = (parsed.subject || '(no subject)').replace(/[\r\n]+/gu, ' ').trim().slice(0, 500)
  const rawKey = `${WORKSPACE_ID}/mail/raw/${messageId}.eml`

  // Keep attachments within the limits; the message says what was left out.
  const omitted: string[] = []
  const attachmentRows = parsed.attachments.flatMap((attachment, index) => {
    const content = typeof attachment.content === 'string' ? new TextEncoder().encode(attachment.content) : new Uint8Array(attachment.content)
    const filename = safeFilename(attachment.filename, index)
    if (!content.byteLength) return []
    if (content.byteLength > MAIL_LIMITS.attachmentBytes) {
      omitted.push(`${filename} (${formatBytes(content.byteLength)})`)
      return []
    }
    const id = newId()
    return [{
      id,
      filename,
      contentType: attachment.mimeType || 'application/octet-stream',
      content,
      size: content.byteLength,
      key: `${WORKSPACE_ID}/mail/attachments/${messageId}/${id}-${filename}`,
    }]
  })
  if (!env.FILES) omitted.push(...attachmentRows.splice(0).map(attachment => `${attachment.filename} (R2 is disabled)`))
  for (const extra of attachmentRows.splice(MAIL_LIMITS.attachments)) omitted.push(extra.filename)
  const body = plainMailBody(parsed.text, parsed.html)
  const content = omitted.length
    ? `${body}\n\n[L4 did not keep ${omitted.length === 1 ? 'this attachment' : `these ${omitted.length} attachments`}: ${omitted.join(', ')}]`
    : body

  const participants = mergeMailAddresses(
    mailAddressList(thread?.participantsJson),
    [from.address, ...to.map(item => item.address), ...cc.map(item => item.address)],
  ).filter(address => address !== mailbox.address)
  const statements: D1PreparedStatement[] = []
  const threadChannelId = thread?.channelId ?? newId()
  const messageChannelId = thread ? threadChannelId : mailbox.channelId
  if (!thread) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO messages (id, channel_id, author_id, content, reply_to_id, edited_at, deleted_at, created_at)
         VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?)`,
      ).bind(messageId, mailbox.channelId, MAIL_EXTERNAL_USER_ID, content, created),
      env.DB.prepare(
        `INSERT INTO channels (id, name, topic, type, visibility, category_id, position, huddle_meeting_id, parent_id, parent_message_id, created_at, updated_at)
         VALUES (?, ?, '', 'thread', 'private', NULL, 0, NULL, ?, ?, ?, ?)`,
      ).bind(threadChannelId, subject.slice(0, 80), mailbox.channelId, messageId, created, created),
      env.DB.prepare(
        `INSERT INTO email_threads (channel_id, mailbox_channel_id, subject, status, participants_json, last_message_at, created_at, updated_at)
         VALUES (?, ?, ?, 'inbox', ?, ?, ?, ?)`,
      ).bind(threadChannelId, mailbox.channelId, subject, JSON.stringify(participants), created, created, created),
    )
  }
  else {
    statements.push(
      env.DB.prepare(
        `INSERT INTO messages (id, channel_id, author_id, content, reply_to_id, edited_at, deleted_at, created_at)
         VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?)`,
      ).bind(messageId, threadChannelId, MAIL_EXTERNAL_USER_ID, content, created),
      env.DB.prepare(
        `UPDATE email_threads SET status = 'inbox', participants_json = ?, last_message_at = ?, updated_at = ? WHERE channel_id = ?`,
      ).bind(JSON.stringify(participants), created, created, threadChannelId),
    )
  }
  statements.push(
    env.DB.prepare(
      `INSERT INTO email_messages
       (message_id, thread_channel_id, mailbox_channel_id, direction, from_address, from_name, to_json, cc_json, bcc_json,
        rfc_message_id, in_reply_to, references_json, delivery_status, raw_r2_key, client_request_id, created_at)
       VALUES (?, ?, ?, 'inbound', ?, ?, ?, ?, ?, ?, ?, ?, 'received', ?, ?, ?)`,
    ).bind(
      messageId,
      threadChannelId,
      mailbox.channelId,
      from.address,
      from.name || null,
      JSON.stringify(mergeMailAddresses(to.map(item => item.address))),
      JSON.stringify(mergeMailAddresses(cc.map(item => item.address))),
      JSON.stringify(mergeMailAddresses(bcc.map(item => item.address))),
      parsed.messageId || null,
      parsed.inReplyTo || null,
      JSON.stringify(refs),
      env.FILES ? rawKey : null,
      rawHash,
      created,
    ),
    ...(env.FILES ? attachmentRows : []).map(attachment => env.DB.prepare(
      `INSERT INTO attachments
       (id, message_id, channel_id, uploader_id, r2_key, filename, content_type, size_bytes, width, height, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
    ).bind(attachment.id, messageId, messageChannelId, MAIL_EXTERNAL_USER_ID, attachment.key, attachment.filename, attachment.contentType, attachment.size, created)),
  )

  // Files go to R2 before their rows exist; if the rows cannot be written, remove them again.
  const files = env.FILES
  const keys = [rawKey, ...attachmentRows.map(attachment => attachment.key)]
  try {
    if (files) await Promise.all([
      files.put(rawKey, raw, { httpMetadata: { contentType: 'message/rfc822' } }),
      ...attachmentRows.map(attachment => files.put(attachment.key, attachment.content, { httpMetadata: { contentType: attachment.contentType } })),
    ])
    await env.DB.batch(statements)
  }
  catch (error) {
    await files?.delete(keys).catch(() => {})
    // Another delivery of the same email saved it first.
    if (/UNIQUE constraint failed/iu.test(error instanceof Error ? error.message : String(error))) return { accepted: true }
    throw error
  }
  try {
    await signalMailChanged(env, mailbox.channelId, threadChannelId)
  }
  catch {
    // The email is stored; open mail views still pick it up on their next refresh.
  }
  return { accepted: true }
}

export async function receiveWorkspaceEmail(message: ForwardableEmailMessage, env: L4Env): Promise<void> {
  const result = await ingestWorkspaceEmail({ from: message.from, to: message.to, raw: message.raw, rawSize: message.rawSize }, env)
  if (!result.accepted) message.setReject(result.reason)
}
