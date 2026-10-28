import type { MailThreadPageDTO } from '../../shared/types'
import type { MailFolder } from '../../shared/paths'
import type { L4Env } from '../../workers/env'
import { mailThreadDto } from './mail-data'

export const MAIL_THREAD_PAGE_SIZE = 50

/** Cursor for the next page: the last conversation's sort time and id, newest first. */
export function parseMailCursor(value: unknown): { at: string; id: string } | null {
  if (typeof value !== 'string') return null
  const separator = value.lastIndexOf('|')
  if (separator <= 0) return null
  return { at: value.slice(0, separator), id: value.slice(separator + 1) }
}

const hasInbound = `EXISTS (SELECT 1 FROM email_messages em WHERE em.thread_channel_id = t.channel_id AND em.direction = 'inbound')`
const lastSent = `(SELECT max(em.created_at) FROM email_messages em WHERE em.thread_channel_id = t.channel_id AND em.direction = 'outbound')`

/**
 * What each folder lists, like Gmail:
 * - Inbox: conversations in the inbox that someone has written to you in. One you
 *   started appears once it gets a reply.
 * - Sent: every conversation you have sent email in, by when you last sent,
 *   whatever folder it is in except Spam and Trash.
 * - Archive, Spam, Trash: conversations moved there.
 */
function folderQuery(folder: MailFolder): { filter: string; sortAt: string } {
  if (folder === 'sent') return { filter: `t.status NOT IN ('spam', 'trash')`, sortAt: lastSent }
  if (folder === 'inbox') return { filter: `t.status = 'inbox' AND ${hasInbound}`, sortAt: 't.last_message_at' }
  return { filter: `t.status = '${folder}'`, sortAt: 't.last_message_at' }
}

/** Search text for a folder: trimmed, lowercased and bounded. Empty means no search. */
export function mailSearchTerm(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const term = value.trim().toLowerCase().slice(0, 200)
  return term || null
}

/**
 * Conversations matching a search: the subject, an address or sender name, or the
 * text of any email or internal note in it. The caller has checked mailbox access.
 */
const searchFilter = `(? IS NULL
  OR instr(lower(t.subject), ?) > 0
  OR instr(lower(t.participants_json), ?) > 0
  OR EXISTS (SELECT 1 FROM email_messages em WHERE em.thread_channel_id = t.channel_id
    AND (instr(lower(coalesce(em.from_name, '')), ?) > 0 OR instr(lower(em.from_address), ?) > 0))
  OR EXISTS (SELECT 1 FROM messages m WHERE (m.channel_id = t.channel_id OR m.id = c.parent_message_id)
    AND m.deleted_at IS NULL AND instr(lower(m.content), ?) > 0))`

export async function listMailThreads(
  env: L4Env,
  input: { mailboxId: string; userId: string; folder: MailFolder; before?: unknown; search?: string | null; unreadOnly?: boolean; limit?: number },
): Promise<MailThreadPageDTO> {
  const { filter, sortAt } = folderQuery(input.folder)
  const limit = Math.max(1, Math.min(Math.floor(input.limit ?? MAIL_THREAD_PAGE_SIZE), MAIL_THREAD_PAGE_SIZE))
  const cursor = parseMailCursor(input.before)
  const search = mailSearchTerm(input.search)
  // The preview is the conversation's latest reply, or the message that started
  // it, which lives in the mailbox. Two lookups keep both on their indexes.
  const rows = await env.DB.prepare(
    `SELECT * FROM (
       SELECT t.channel_id as channelId, t.mailbox_channel_id as mailboxChannelId, t.subject, t.status,
         t.participants_json as participantsJson, ${sortAt} as lastMessageAt,
         coalesce(p.content, '') as preview, pe.direction = 'inbound' as previewInbound,
         CASE WHEN r.last_read_message_id IS NULL OR r.last_read_message_id <
           (SELECT max(em.message_id) FROM email_messages em WHERE em.thread_channel_id = t.channel_id AND em.direction = 'inbound')
           THEN 1 ELSE 0 END as unread
       FROM email_threads t
       JOIN channels c ON c.id = t.channel_id
       LEFT JOIN messages p ON p.id = coalesce(
         (SELECT m.id FROM messages m WHERE m.channel_id = t.channel_id ORDER BY m.created_at DESC, m.id DESC LIMIT 1),
         c.parent_message_id
       )
       LEFT JOIN email_messages pe ON pe.message_id = p.id
       LEFT JOIN channel_reads r ON r.channel_id = t.channel_id AND r.user_id = ?
       WHERE t.mailbox_channel_id = ? AND ${filter} AND ${searchFilter}
     )
     WHERE lastMessageAt IS NOT NULL AND (? = 0 OR unread = 1)
       AND (? IS NULL OR lastMessageAt < ? OR (lastMessageAt = ? AND channelId < ?))
     ORDER BY lastMessageAt DESC, channelId DESC LIMIT ?`,
  ).bind(
    input.userId, input.mailboxId, ...Array.from({ length: 6 }, () => search), input.unreadOnly ? 1 : 0,
    cursor?.at ?? null, cursor?.at ?? null, cursor?.at ?? null, cursor?.id ?? null,
    limit + 1,
  ).all<Parameters<typeof mailThreadDto>[0]>()
  const results = rows.results || []
  const page = results.slice(0, limit)
  const last = page.at(-1)
  return {
    threads: page.map(mailThreadDto),
    nextCursor: results.length > limit && last ? `${last.lastMessageAt}|${last.channelId}` : null,
  }
}
