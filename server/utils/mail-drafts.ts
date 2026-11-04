import { z } from 'zod'
import type { L4Env } from '../../workers/env'
import type { MailDraftDTO } from '../../shared/types'
import { MAIL_LIMITS } from '../../shared/mail'
import { MAIL_OUTBOUND_LIMITS } from '../../shared/mail-attachments'
import { newId, nowIso } from '../../shared/ids'
import { attachmentDto } from './messages'
import { discardMailUploadStatements } from './mail-attachments'
import { fail } from './cf'

/** Drafts one person can keep in one mailbox. */
export const MAIL_DRAFT_LIMIT = 100

/** Addresses are kept as typed: a draft may hold an address that is not finished yet. */
const addresses = z.array(z.string().trim().max(254)).max(MAIL_LIMITS.addresses).default([])
export const mailDraftSchema = z.object({
  id: z.string().trim().min(1).max(80).optional(),
  threadId: z.string().trim().min(1).max(80).nullish(),
  to: addresses,
  cc: addresses,
  bcc: addresses,
  subject: z.string().max(500).default('').transform(value => value.replace(/[\r\n]+/gu, ' ')),
  content: z.string().max(100_000).default(''),
  format: z.enum(['text', 'markdown']).default('text'),
  attachmentIds: z.array(z.string().trim().min(1).max(80)).max(MAIL_OUTBOUND_LIMITS.attachments).default([]),
})
export type MailDraftInput = z.infer<typeof mailDraftSchema>

type DraftRow = {
  id: string
  mailboxChannelId: string
  threadChannelId: string | null
  threadSubject: string | null
  toJson: string
  ccJson: string
  bccJson: string
  subject: string
  content: string
  bodyFormat: 'text' | 'markdown'
  attachmentIdsJson: string
  updatedAt: string
}

function list(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  }
  catch { return [] }
}

const draftColumns = `d.id, d.mailbox_channel_id as mailboxChannelId, d.thread_channel_id as threadChannelId, t.subject as threadSubject,
  d.to_json as toJson, d.cc_json as ccJson, d.bcc_json as bccJson, d.subject, d.content, d.body_format as bodyFormat,
  d.attachment_ids_json as attachmentIdsJson, d.updated_at as updatedAt`

/** Drafts are only ever read for their author; every caller has checked the mailbox grant. */
export async function listMailDrafts(env: L4Env, mailboxId: string, authorId: string, draftId?: string): Promise<MailDraftDTO[]> {
  const rows = (await env.DB.prepare(
    `SELECT ${draftColumns} FROM mail_drafts d LEFT JOIN email_threads t ON t.channel_id = d.thread_channel_id
     WHERE d.mailbox_channel_id = ? AND d.author_id = ? AND (? IS NULL OR d.id = ?)
     ORDER BY d.updated_at DESC, d.id DESC LIMIT ?`,
  ).bind(mailboxId, authorId, draftId ?? null, draftId ?? null, MAIL_DRAFT_LIMIT).all<DraftRow>()).results ?? []
  const ids = [...new Set(rows.flatMap(row => list(row.attachmentIdsJson)))]
  const files = ids.length
    ? (await env.DB.prepare(
        `SELECT id, message_id as messageId, channel_id as channelId, uploader_id as uploaderId, r2_key as r2Key, filename,
           content_type as contentType, size_bytes as sizeBytes, width, height, created_at as createdAt
         FROM attachments WHERE id IN (${ids.map(() => '?').join(',')}) AND message_id IS NULL AND uploader_id = ? AND channel_id = ?`,
      ).bind(...ids, authorId, mailboxId).all<Parameters<typeof attachmentDto>[0]>()).results ?? []
    : []
  const byId = new Map(files.map(file => [file.id, attachmentDto(file)]))
  return rows.map(row => ({
    id: row.id,
    mailboxChannelId: row.mailboxChannelId,
    threadId: row.threadChannelId,
    threadSubject: row.threadSubject,
    to: list(row.toJson),
    cc: list(row.ccJson),
    bcc: list(row.bccJson),
    subject: row.subject,
    content: row.content,
    format: row.bodyFormat,
    attachments: list(row.attachmentIdsJson).flatMap(id => byId.get(id) ?? []),
    updatedAt: row.updatedAt,
  }))
}

/**
 * Creates or updates the author's draft. A reply draft is one per conversation,
 * so saving one for the same conversation updates it. Attachments that are not
 * the author's unsent uploads in this mailbox are dropped.
 */
export async function saveMailDraft(env: L4Env, mailboxId: string, authorId: string, input: MailDraftInput): Promise<MailDraftDTO> {
  const threadId = input.threadId ?? null
  if (threadId) {
    const thread = await env.DB.prepare('SELECT 1 AS found FROM email_threads WHERE channel_id = ? AND mailbox_channel_id = ?').bind(threadId, mailboxId).first()
    if (!thread) fail(404, 'not_found', 'Email conversation not found')
  }
  const existing = await env.DB.prepare(
    `SELECT id, thread_channel_id as threadId FROM mail_drafts WHERE author_id = ? AND mailbox_channel_id = ?
     AND ((? IS NOT NULL AND id = ?) OR (? IS NOT NULL AND thread_channel_id = ?))
     ORDER BY id = ? DESC LIMIT 1`,
  ).bind(authorId, mailboxId, input.id ?? null, input.id ?? null, threadId, threadId, input.id ?? null).first<{ id: string; threadId: string | null }>()
  if (input.id && !existing) fail(404, 'not_found', 'Draft not found')
  if (existing && existing.threadId !== threadId) fail(409, 'conflict', 'This draft belongs to another conversation')
  const requested = [...new Set(input.attachmentIds)]
  const owned = requested.length
    ? new Set(((await env.DB.prepare(
        `SELECT id FROM attachments WHERE id IN (${requested.map(() => '?').join(',')}) AND message_id IS NULL AND uploader_id = ? AND channel_id = ?`,
      ).bind(...requested, authorId, mailboxId).all<{ id: string }>()).results ?? []).map(row => row.id))
    : new Set<string>()
  const attachmentIds = requested.filter(id => owned.has(id))
  const updated = nowIso()
  const values = [JSON.stringify(input.to), JSON.stringify(input.cc), JSON.stringify(input.bcc), input.subject, input.content, input.format, JSON.stringify(attachmentIds), updated]
  let id = existing?.id
  if (id) {
    await env.DB.prepare(
      `UPDATE mail_drafts SET to_json = ?, cc_json = ?, bcc_json = ?, subject = ?, content = ?, body_format = ?, attachment_ids_json = ?, updated_at = ?
       WHERE id = ? AND author_id = ?`,
    ).bind(...values, id, authorId).run()
  }
  else {
    const count = await env.DB.prepare('SELECT count(*) AS n FROM mail_drafts WHERE author_id = ? AND mailbox_channel_id = ?').bind(authorId, mailboxId).first<{ n: number }>()
    if ((count?.n ?? 0) >= MAIL_DRAFT_LIMIT) fail(409, 'draft_limit', `You can keep up to ${MAIL_DRAFT_LIMIT} drafts in a mailbox. Send or discard one first.`)
    id = newId()
    await env.DB.prepare(
      `INSERT INTO mail_drafts (id, mailbox_channel_id, thread_channel_id, author_id, to_json, cc_json, bcc_json, subject, content, body_format, attachment_ids_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(author_id, thread_channel_id) WHERE thread_channel_id IS NOT NULL DO UPDATE SET
         to_json = excluded.to_json, cc_json = excluded.cc_json, bcc_json = excluded.bcc_json, subject = excluded.subject, content = excluded.content,
         body_format = excluded.body_format, attachment_ids_json = excluded.attachment_ids_json, updated_at = excluded.updated_at`,
    ).bind(id, mailboxId, threadId, authorId, ...values.slice(0, 7), updated, updated).run()
    // A concurrent save for the same conversation kept its own id.
    if (threadId) id = (await env.DB.prepare('SELECT id FROM mail_drafts WHERE author_id = ? AND thread_channel_id = ?').bind(authorId, threadId).first<{ id: string }>())?.id ?? id
  }
  return (await listMailDrafts(env, mailboxId, authorId, id))[0]!
}

/** The author's draft in this mailbox, for sending or discarding. */
export async function findMailDraft(env: L4Env, mailboxId: string, authorId: string, draftId: string) {
  return env.DB.prepare(
    `SELECT id, thread_channel_id as threadId, attachment_ids_json as attachmentIdsJson FROM mail_drafts
     WHERE id = ? AND mailbox_channel_id = ? AND author_id = ?`,
  ).bind(draftId, mailboxId, authorId).first<{ id: string; threadId: string | null; attachmentIdsJson: string }>()
}

/**
 * Removes a draft. Its uploads go too, except those an email is now carrying,
 * which the same batch attaches to that email.
 */
export function deleteMailDraftStatements(env: L4Env, draft: { id: string; attachmentIdsJson: string }, authorId: string, keep: string[] = []): D1PreparedStatement[] {
  const kept = new Set(keep)
  return [
    env.DB.prepare('DELETE FROM mail_drafts WHERE id = ? AND author_id = ?').bind(draft.id, authorId),
    ...discardMailUploadStatements(env, list(draft.attachmentIdsJson).filter(id => !kept.has(id)), authorId),
  ]
}
