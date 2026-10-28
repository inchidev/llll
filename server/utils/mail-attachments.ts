import type { L4Env } from '../../workers/env'
import type { AttachmentDTO } from '../../shared/types'
import { fileStorage } from '../../shared/file-storage'
import { newId, nowIso } from '../../shared/ids'
import { MAIL_FILES_UNAVAILABLE, MAIL_OUTBOUND_LIMITS, blockedMailAttachment, mailAttachmentFilename, mailAttachmentLimitError, mailAttachmentType, mailFilesAvailable } from '../../shared/mail-attachments'
import { formatBytes } from '../../shared/format'
import { attachmentDto } from './messages'
import { fail } from './cf'

type AttachmentRow = Parameters<typeof attachmentDto>[0]

const columns = `id, message_id as messageId, channel_id as channelId, uploader_id as uploaderId, r2_key as r2Key, filename,
  content_type as contentType, size_bytes as sizeBytes, width, height, created_at as createdAt`

/** Pending uploads older than this, and on no draft, are removed. */
export const MAIL_UPLOAD_TTL_MS = 24 * 60 * 60_000

export function requireMailFiles(env: L4Env): void {
  if (!mailFilesAvailable(env)) fail(409, 'mail_files_unavailable', MAIL_FILES_UNAVAILABLE)
}

/**
 * Stores one file the sender will attach to an email. It stays private to its
 * uploader, unattached to any message, until an email or draft uses it.
 */
export async function storeMailUpload(env: L4Env, input: { serverId: string; mailboxId: string; userId: string; bytes: Uint8Array; filename: string | null | undefined }): Promise<AttachmentDTO> {
  requireMailFiles(env)
  const filename = mailAttachmentFilename(input.filename)
  if (!input.bytes.byteLength) fail(400, 'bad_request', 'The file is empty')
  if (input.bytes.byteLength > MAIL_OUTBOUND_LIMITS.attachmentBytes) fail(413, 'too_large', `Email attachments can be up to ${formatBytes(MAIL_OUTBOUND_LIMITS.attachmentBytes)}`)
  if (blockedMailAttachment(input.bytes, filename)) fail(415, 'unsupported_type', 'Programs and scripts cannot be sent by email')
  const id = newId()
  const row: AttachmentRow = {
    id,
    messageId: null,
    channelId: input.mailboxId,
    uploaderId: input.userId,
    r2Key: `${input.serverId}/mail/outbound/${input.mailboxId}/${id}-${filename.replace(/[^\w.-]+/gu, '_').slice(0, 80)}`,
    filename,
    contentType: mailAttachmentType(input.bytes, filename),
    sizeBytes: input.bytes.byteLength,
    width: null,
    height: null,
    createdAt: nowIso(),
  }
  const files = fileStorage(env)
  await files.put(row.r2Key, input.bytes, { httpMetadata: { contentType: row.contentType } })
  try {
    await env.DB.prepare(
      `INSERT INTO attachments (id, message_id, channel_id, uploader_id, r2_key, filename, content_type, size_bytes, width, height, created_at)
       VALUES (?, NULL, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
    ).bind(row.id, row.channelId, row.uploaderId, row.r2Key, row.filename, row.contentType, row.sizeBytes, row.createdAt).run()
  }
  catch (error) {
    await files.delete(row.r2Key).catch(() => {})
    throw error
  }
  return attachmentDto(row)
}

/** A file from an email in this mailbox, for Forward. Deleted messages and other mailboxes are not reachable. */
export async function mailboxAttachment(env: L4Env, mailboxId: string, attachmentId: string): Promise<AttachmentRow | null> {
  return env.DB.prepare(
    `SELECT ${columns} FROM attachments WHERE id = (
       SELECT a.id FROM attachments a
       JOIN messages m ON m.id = a.message_id AND m.deleted_at IS NULL
       JOIN email_messages em ON em.message_id = m.id AND em.mailbox_channel_id = ?
       WHERE a.id = ?)`,
  ).bind(mailboxId, attachmentId).first<AttachmentRow>()
}

/** The sender's own unsent uploads in this mailbox, all of them or a failure. */
export async function pendingMailAttachments(env: L4Env, input: { mailboxId: string; userId: string; ids: string[] }): Promise<AttachmentRow[]> {
  const ids = [...new Set(input.ids)]
  if (!ids.length) return []
  requireMailFiles(env)
  const rows = (await env.DB.prepare(
    `SELECT ${columns} FROM attachments WHERE id IN (${ids.map(() => '?').join(',')}) AND message_id IS NULL AND channel_id = ? AND uploader_id = ?`,
  ).bind(...ids, input.mailboxId, input.userId).all<AttachmentRow>()).results ?? []
  if (rows.length !== ids.length) fail(400, 'bad_request', 'An attachment is missing or was already sent')
  const limit = mailAttachmentLimitError(rows)
  if (limit) fail(413, 'too_large', limit)
  return ids.map(id => rows.find(row => row.id === id)!)
}

/**
 * Moves uploads onto the email in the same batch that creates it. If another
 * email took one first, the guard breaks the size check and the batch rolls back.
 */
export function attachMailStatements(env: L4Env, rows: AttachmentRow[], messageId: string, channelId: string): D1PreparedStatement[] {
  if (!rows.length) return []
  const placeholders = rows.map(() => '?').join(',')
  return [
    ...rows.map(row => env.DB.prepare('UPDATE attachments SET message_id = ?, channel_id = ? WHERE id = ? AND message_id IS NULL AND uploader_id = ?')
      .bind(messageId, channelId, row.id, row.uploaderId)),
    env.DB.prepare(`UPDATE attachments SET size_bytes = 0 WHERE id IN (${placeholders}) AND message_id IS NOT ?`).bind(...rows.map(row => row.id), messageId),
  ]
}

export function isAttachmentTaken(error: unknown): boolean {
  return /CHECK constraint failed: attachments_size_check/iu.test(error instanceof Error ? error.message : String(error))
}

/** Removes pending uploads: queued for blob deletion in the same transaction that drops their rows. */
export function discardMailUploadStatements(env: L4Env, ids: string[], userId: string): D1PreparedStatement[] {
  if (!ids.length) return []
  const placeholders = ids.map(() => '?').join(',')
  return [
    env.DB.prepare(`INSERT OR IGNORE INTO file_deletions (key, scope_id, created_at)
      SELECT r2_key, channel_id, ? FROM attachments WHERE id IN (${placeholders}) AND message_id IS NULL AND uploader_id = ?`).bind(nowIso(), ...ids, userId),
    env.DB.prepare(`DELETE FROM attachments WHERE id IN (${placeholders}) AND message_id IS NULL AND uploader_id = ?`).bind(...ids, userId),
  ]
}

/** Uploads the sender left behind: not sent, not on a draft, and older than a day. */
export async function sweepMailUploads(env: L4Env, mailboxId: string, userId: string): Promise<void> {
  const stale = (await env.DB.prepare(
    `SELECT a.id FROM attachments a WHERE a.channel_id = ? AND a.uploader_id = ? AND a.message_id IS NULL AND a.created_at < ?
       AND NOT EXISTS (SELECT 1 FROM mail_drafts d, json_each(d.attachment_ids_json) j WHERE d.author_id = a.uploader_id AND d.mailbox_channel_id = a.channel_id AND j.value = a.id)
     LIMIT 100`,
  ).bind(mailboxId, userId, new Date(Date.now() - MAIL_UPLOAD_TTL_MS).toISOString()).all<{ id: string }>()).results ?? []
  if (stale.length) await env.DB.batch(discardMailUploadStatements(env, stale.map(row => row.id), userId))
}
