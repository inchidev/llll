import type { L4Env } from '../../workers/env'
import { sendServerEmail } from '../../workers/mail-transport'
import { mailAddressList, mailReplyRecipients, mailDeliveryUncertain } from '../../shared/mail'

type OutboundRow = {
  messageId: string
  threadChannelId: string
  messageChannelId: string
  fromAddress: string
  fromName: string | null
  toJson: string
  ccJson: string
  bccJson: string
  inReplyTo: string | null
  referencesJson: string
  deliveryStatus: 'pending' | 'sent' | 'failed'
  deliveryAttempts: number
  deliveryStartedAt: string | null
  createdAt: string
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
export async function deliverOutboundEmail(env: L4Env, messageId: string, options: { retryUncertain?: boolean } = {}): Promise<void> {
  const row = await env.DB.prepare(
    `SELECT em.message_id as messageId, em.thread_channel_id as threadChannelId, m.channel_id as messageChannelId,
       em.from_address as fromAddress, em.from_name as fromName, em.to_json as toJson, em.cc_json as ccJson, em.bcc_json as bccJson,
       em.in_reply_to as inReplyTo, em.references_json as referencesJson,
       em.delivery_status as deliveryStatus, em.delivery_attempts as deliveryAttempts,
       em.delivery_started_at as deliveryStartedAt, em.created_at as createdAt,
       m.content, t.subject
     FROM email_messages em
     JOIN messages m ON m.id = em.message_id
     JOIN email_threads t ON t.channel_id = em.thread_channel_id
     WHERE em.message_id = ? AND em.direction = 'outbound'`,
  ).bind(messageId).first<OutboundRow>()
  if (!row) return

  const started = new Date().toISOString()
  const uncertain = mailDeliveryUncertain(row)
  const claim = await env.DB.prepare(
    `UPDATE email_messages SET delivery_status = 'pending', delivery_attempts = delivery_attempts + 1, delivery_error = NULL, delivery_started_at = ?
     WHERE message_id = ? AND delivery_attempts = ?
       AND ((delivery_status = 'pending' AND delivery_attempts = 0) OR delivery_status = 'failed' OR (delivery_status = 'pending' AND ? = 1))`,
  ).bind(started, messageId, row.deliveryAttempts, options.retryUncertain && uncertain ? 1 : 0).run()
  if (!claim.meta.changes) return

  // A reply lives in the conversation; the message that started it lives in the mailbox.
  const isReply = row.messageChannelId === row.threadChannelId
  const references = parseReferences(row.referencesJson)
  let result: Awaited<ReturnType<typeof sendServerEmail>>
  try {
    result = await sendServerEmail(env, {
      from: row.fromName ? { email: row.fromAddress, name: row.fromName } : row.fromAddress,
      to: mailAddressList(row.toJson),
      ...(mailAddressList(row.ccJson).length ? { cc: mailAddressList(row.ccJson) } : {}),
      ...(mailAddressList(row.bccJson).length ? { bcc: mailAddressList(row.bccJson) } : {}),
      subject: isReply && !/^re:/iu.test(row.subject) ? `Re: ${row.subject}` : row.subject,
      text: row.content,
      headers: {
        ...(isRfcMessageId(row.inReplyTo) ? { 'In-Reply-To': row.inReplyTo } : {}),
        ...(references.length ? { References: references.join(' ') } : {}),
      },
    })
  }
  catch (error) {
    await env.DB.prepare("UPDATE email_messages SET delivery_status = 'failed', delivery_error = ? WHERE message_id = ? AND delivery_attempts = ?")
      .bind(deliveryError(error), messageId, row.deliveryAttempts + 1).run()
    return
  }
  // A receipt failure is uncertain delivery, never a known send failure. Retrying
  // needs an explicit human decision because the recipient may already have it.
  await env.DB.prepare(
    `UPDATE email_messages SET delivery_status = 'sent', provider_message_id = ?, rfc_message_id = ?, delivered_at = ?, delivery_error = NULL
     WHERE message_id = ? AND delivery_attempts = ?`,
  ).bind(result.messageId, isRfcMessageId(result.messageId) ? result.messageId : null, new Date().toISOString(), messageId, row.deliveryAttempts + 1).run()
}

function isRfcMessageId(value: string | null): value is string {
  return Boolean(value && /^<[^<>\s@]+@[^<>\s@]+>$/u.test(value))
}

function parseReferences(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown
    return Array.isArray(parsed) ? [...new Set(parsed.filter((item): item is string => typeof item === 'string' && isRfcMessageId(item)))] : []
  }
  catch {
    return []
  }
}

/**
 * Reply uses Reply-To, falling back to the latest sender. Reply all also
 * includes To and Cc, excluding the mailbox itself. A conversation that
 * has only outbound mail replies to the people it was sent to.
 */
export async function replyRecipients(env: L4Env, threadId: string, mailboxAddress: string, mode: 'reply' | 'all' = 'reply'): Promise<string[]> {
  const [inbound, thread] = await Promise.all([
    env.DB.prepare(
      `SELECT from_address as fromAddress, reply_to_json as replyToJson, to_json as toJson, cc_json as ccJson FROM email_messages
       WHERE thread_channel_id = ? AND direction = 'inbound' ORDER BY created_at DESC LIMIT 1`,
    ).bind(threadId).first<{ fromAddress: string; replyToJson: string; toJson: string; ccJson: string }>(),
    env.DB.prepare('SELECT participants_json as participantsJson FROM email_threads WHERE channel_id = ?')
      .bind(threadId).first<{ participantsJson: string }>(),
  ])
  return mailReplyRecipients(inbound ? {
    fromAddress: inbound.fromAddress,
    replyTo: mailAddressList(inbound.replyToJson),
    to: mailAddressList(inbound.toJson),
    cc: mailAddressList(inbound.ccJson),
  } : null, mailAddressList(thread?.participantsJson), mailboxAddress, mode === 'all')
}

/** The Message-ID a reply answers and the References chain it continues. */
export async function replyThreading(env: L4Env, threadId: string): Promise<{ inReplyTo: string | null; references: string[] }> {
  const previous = await env.DB.prepare(
    `SELECT rfc_message_id as rfcMessageId, references_json as referencesJson FROM email_messages
     WHERE thread_channel_id = ? AND rfc_message_id LIKE '<%@%>' ORDER BY created_at DESC LIMIT 1`,
  ).bind(threadId).first<{ rfcMessageId: string; referencesJson: string }>()
  if (!previous || !isRfcMessageId(previous.rfcMessageId)) return { inReplyTo: null, references: [] }
  return {
    inReplyTo: previous.rfcMessageId,
    references: [...new Set([...parseReferences(previous.referencesJson), previous.rfcMessageId])],
  }
}
