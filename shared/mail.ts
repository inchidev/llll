import type { MailboxPermission } from './types'

export const MAIL_DOMAIN_ID = 'main'
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
