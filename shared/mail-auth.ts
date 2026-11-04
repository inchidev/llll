/** What the hop that received a message found. Each is RFC 8601's result word, lowercase. */
export type MailAuthResults = { dmarc?: string; dkim?: string; spf?: string }
/** Stored on inbound mail. Mail that is not `verified` is kept, but never trusted to join or steer a conversation. */
export type MailAuthVerdict = 'verified' | 'failed' | 'unverified'

/** Email Routing's identifier for itself, which its documentation says to check. */
export const CLOUDFLARE_AUTHSERV_ID = 'mx.cloudflare.net'

/**
 * Reads the `Authentication-Results` value from Email Routing, which prepends its own. `Headers.get`
 * joins repeats with commas, so everything after the first comma may be the sender's own header and
 * is ignored. Quoted strings and comments go first: their text is partly chosen by the sender. A first
 * header naming anyone else means Email Routing wrote none, and the sender's words prove nothing.
 */
export function trustedAuthResults(value: string | null | undefined, authservId = CLOUDFLARE_AUTHSERV_ID): MailAuthResults | null {
  if (!value) return null
  const plain = value.replace(/"(?:[^"\\]|\\.)*"/gu, '""').replace(/\([^()]*\)/gu, ' ')
  const [identity, ...entries] = (plain.split(',')[0] ?? '').split(';').map(part => part.trim())
  if (identity?.split(/\s+/u)[0]?.toLowerCase() !== authservId) return null
  const results: MailAuthResults = {}
  for (const entry of entries) {
    const match = /^(dmarc|dkim|spf)\s*=\s*([a-z]+)/iu.exec(entry)
    if (!match) continue
    const method = match[1]!.toLowerCase() as keyof MailAuthResults
    const result = match[2]!.toLowerCase()
    // A message can carry several signatures: one good one counts, and one DMARC failure is a failure.
    if (!results[method] || result === (method === 'dmarc' ? 'fail' : 'pass')) results[method] = result
  }
  return results
}

export function mailAuthVerdict(results: MailAuthResults | null | undefined): MailAuthVerdict {
  if (!results) return 'unverified'
  if (results.dmarc === 'fail') return 'failed'
  return Object.values(results).includes('pass') ? 'verified' : 'unverified'
}
