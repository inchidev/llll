import type { L4Env } from '../../workers/env'
import { sendWorkspaceEmail } from '../../workers/mail-transport'
import { mailAddressList, mergeMailAddresses } from '../../shared/mail'

type OutboundRow = {
  messageId: string
  threadChannelId: string
  messageChannelId: string
  fromAddress: string
  fromName: string | null
  toJson: string
  inReplyTo: string | null
  referencesJson: string
  deliveryStatus: 'pending' | 'sent' | 'failed'
  deliveryAttempts: number
  content: string
  subject: string
}

/** A single-line, bounded summary of a transport error, kept for the sender to see. */
function deliveryError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text.replace(/\s+/gu, ' ').trim().slice(0, 500) || 'Delivery failed'
}

/**
 * Delivers one outbound email and records the outcome. Only one caller can
 * deliver a message at a time: an attempt first claims the row, which succeeds
 * for a message never attempted or one whose last attempt failed. A message
 * that is already sent, or being sent by another request, is left alone.
 */
export async function deliverOutboundEmail(env: L4Env, messageId: string): Promise<void> {
  const row = await env.DB.prepare(
    `SELECT em.message_id as messageId, em.thread_channel_id as threadChannelId, m.channel_id as messageChannelId,
       em.from_address as fromAddress, em.from_name as fromName, em.to_json as toJson,
       em.in_reply_to as inReplyTo, em.references_json as referencesJson,
       em.delivery_status as deliveryStatus, em.delivery_attempts as deliveryAttempts,
       m.content, t.subject
     FROM email_messages em
     JOIN messages m ON m.id = em.message_id
     JOIN email_threads t ON t.channel_id = em.thread_channel_id
     WHERE em.message_id = ? AND em.direction = 'outbound'`,
  ).bind(messageId).first<OutboundRow>()
  if (!row) return

  const claim = await env.DB.prepare(
    `UPDATE email_messages SET delivery_status = 'pending', delivery_attempts = delivery_attempts + 1, delivery_error = NULL
     WHERE message_id = ? AND delivery_attempts = ?
       AND ((delivery_status = 'pending' AND delivery_attempts = 0) OR delivery_status = 'failed')`,
  ).bind(messageId, row.deliveryAttempts).run()
  if (!claim.meta.changes) return

  // A reply lives in the conversation; the message that started it lives in the mailbox.
  const isReply = row.messageChannelId === row.threadChannelId
  const references = parseReferences(row.referencesJson)
  try {
    const result = await sendWorkspaceEmail(env, {
      from: row.fromName ? { email: row.fromAddress, name: row.fromName } : row.fromAddress,
      to: mailAddressList(row.toJson),
      subject: isReply && !/^re:/iu.test(row.subject) ? `Re: ${row.subject}` : row.subject,
      text: row.content,
      headers: {
        ...(row.inReplyTo ? { 'In-Reply-To': row.inReplyTo } : {}),
        ...(references.length ? { References: references.join(' ') } : {}),
      },
    })
    await env.DB.prepare(
      `UPDATE email_messages SET delivery_status = 'sent', rfc_message_id = ?, delivered_at = ?, delivery_error = NULL
       WHERE message_id = ?`,
    ).bind(result.messageId || null, new Date().toISOString(), messageId).run()
  }
  catch (error) {
    await env.DB.prepare("UPDATE email_messages SET delivery_status = 'failed', delivery_error = ? WHERE message_id = ?")
      .bind(deliveryError(error), messageId).run()
  }
}

function parseReferences(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown
    return Array.isArray(parsed) ? [...new Set(parsed.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())))] : []
  }
  catch {
    return []
  }
}

/**
 * Who a reply goes to: everyone on the latest email received in the
 * conversation (its sender, To, and Cc), like Reply all. A conversation that
 * has only outbound mail replies to the people it was sent to.
 */
export async function replyRecipients(env: L4Env, threadId: string, mailboxAddress: string): Promise<string[]> {
  const [inbound, thread] = await Promise.all([
    env.DB.prepare(
      `SELECT from_address as fromAddress, to_json as toJson, cc_json as ccJson FROM email_messages
       WHERE thread_channel_id = ? AND direction = 'inbound' ORDER BY created_at DESC LIMIT 1`,
    ).bind(threadId).first<{ fromAddress: string; toJson: string; ccJson: string }>(),
    env.DB.prepare('SELECT participants_json as participantsJson FROM email_threads WHERE channel_id = ?')
      .bind(threadId).first<{ participantsJson: string }>(),
  ])
  const candidates = inbound
    ? mergeMailAddresses([inbound.fromAddress], mailAddressList(inbound.toJson), mailAddressList(inbound.ccJson))
    : mailAddressList(thread?.participantsJson)
  return candidates.filter(address => address !== mailboxAddress.toLowerCase())
}

/** The Message-ID a reply answers and the References chain it continues. */
export async function replyThreading(env: L4Env, threadId: string): Promise<{ inReplyTo: string | null; references: string[] }> {
  const previous = await env.DB.prepare(
    `SELECT rfc_message_id as rfcMessageId, references_json as referencesJson FROM email_messages
     WHERE thread_channel_id = ? AND rfc_message_id IS NOT NULL ORDER BY created_at DESC LIMIT 1`,
  ).bind(threadId).first<{ rfcMessageId: string; referencesJson: string }>()
  if (!previous) return { inReplyTo: null, references: [] }
  return {
    inReplyTo: previous.rfcMessageId,
    references: [...new Set([...parseReferences(previous.referencesJson), previous.rfcMessageId])],
  }
}
