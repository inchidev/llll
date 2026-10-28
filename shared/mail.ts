import type { MailboxPermission } from './types'

export const MAIL_EXTERNAL_USER_ID = 'mail-external'

export function normalizeMailLocalPart(value: string): string {
  const localPart = value.trim().toLowerCase()
  if (!/^[a-z0-9](?:[a-z0-9.!#$%&'*+/=?^_`{|}~-]{0,62}[a-z0-9])?$/u.test(localPart)) {
    throw new Error('Mailbox must use a valid email local part')
  }
  return localPart
}

export function mailAddress(localPart: string, domain: string): string {
  return `${localPart}@${domain}`.toLowerCase()
}

export function mailPermissionAllows(actual: MailboxPermission, needed: MailboxPermission): boolean {
  const rank: Record<MailboxPermission, number> = { read: 1, send: 2, manage: 3 }
  return rank[actual] >= rank[needed]
}

/** Bounds on inbound mail. Email Routing accepts messages up to 25 MiB. */
/**
 * To, Cc and Bcc for an outbound email: each deduplicated, without the mailbox
 * itself, and without an address already listed in an earlier field. The total
 * stays within one email's address limit.
 */
export function outboundRecipients(input: { to: string[]; cc?: string[]; bcc?: string[] }, mailboxAddress: string) {
  const own = mailboxAddress.trim().toLowerCase()
  const seen = new Set<string>([own])
  const pick = (values: string[] | undefined) => mergeMailAddresses(values ?? []).filter(value => !seen.has(value) && seen.add(value))
  const to = pick(input.to), cc = pick(input.cc), bcc = pick(input.bcc)
  return { to, cc, bcc, total: to.length + cc.length + bcc.length }
}

/**
 * A new email forwarding an earlier one: `Fwd:` subject and the original quoted under
 * the usual header block, with room to write above it. Attachments are not copied.
 */
export function forwardedEmail(original: { subject: string; fromName: string | null; fromAddress: string; date: string; to: string[]; cc: string[]; content: string }) {
  const from = original.fromName ? `${original.fromName} <${original.fromAddress}>` : original.fromAddress
  const header = ['---------- Forwarded message ----------', `From: ${from}`, `Date: ${original.date}`, `Subject: ${original.subject}`,
    `To: ${original.to.join(', ')}`, ...(original.cc.length ? [`Cc: ${original.cc.join(', ')}`] : [])].join('\n')
  return {
    subject: /^fwd?:/iu.test(original.subject) ? original.subject : `Fwd: ${original.subject}`,
    body: `\n\n${header}\n\n${original.content}`,
  }
}

export const MAIL_LIMITS = {
  rawBytes: 25 * 1024 * 1024,
  attachments: 20,
  attachmentBytes: 10 * 1024 * 1024,
  addresses: 100,
} as const

/**
 * Reads a stored list of email addresses. Stored lists are JSON arrays; anything
 * malformed reads as empty instead of failing the whole mailbox.
 */
export function mailAddressList(value: string | null | undefined): string[] {
  if (!value) return []
  try {
    const parsed = JSON.parse(value) as unknown
    return Array.isArray(parsed) ? mergeMailAddresses(parsed.filter((item): item is string => typeof item === 'string')) : []
  }
  catch {
    return []
  }
}

/** Lowercased, trimmed, de-duplicated addresses in first-seen order, bounded in length. */
export function mergeMailAddresses(...lists: string[][]): string[] {
  const seen = new Set<string>()
  for (const address of lists.flat()) {
    const normalized = address.trim().toLowerCase()
    if (normalized && !seen.has(normalized)) seen.add(normalized)
    if (seen.size >= MAIL_LIMITS.addresses) break
  }
  return [...seen]
}

/** An interrupted attempt is only eligible for a deliberate resend after its lease. */
export const MAIL_DELIVERY_LEASE_MS = 5 * 60_000
export function mailDeliveryUncertain(row: { deliveryStatus: string; deliveryAttempts: number; deliveryStartedAt: string | null; createdAt: string }, now = Date.now()): boolean {
  return row.deliveryStatus === 'pending' && row.deliveryAttempts > 0
    && Date.parse(row.deliveryStartedAt || row.createdAt) <= now - MAIL_DELIVERY_LEASE_MS
}

/** Defaults shared by the reply editor and the server; explicit edits are validated by the API. */
export function mailReplyRecipients(inbound: { fromAddress: string; replyTo?: string[]; to: string[]; cc: string[] } | null, participants: string[], mailboxAddress: string, replyAll = false): string[] {
  const candidates = inbound
    ? mergeMailAddresses(inbound.replyTo?.length ? inbound.replyTo : [inbound.fromAddress], ...(replyAll ? [inbound.to, inbound.cc] : []))
    : mergeMailAddresses(participants)
  return candidates.filter(address => address !== mailboxAddress.toLowerCase())
}
