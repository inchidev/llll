/** What the hop that received a message found. Each is RFC 8601's result word, lowercase. */
export type MailAuthResults = {
  dmarc?: string
  dkim?: string
  spf?: string
  /** Domains whose DKIM signature passed. */
  dkimDomains?: string[]
  /** The envelope domain SPF passed for. */
  spfDomain?: string
}
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
    const method = match[1]!.toLowerCase() as 'dmarc' | 'dkim' | 'spf'
    const result = match[2]!.toLowerCase()
    if (result === 'pass' && method === 'dkim') {
      const domain = /\bheader\.d\s*=\s*([^\s;]+)/iu.exec(entry)?.[1]?.toLowerCase()
      if (domain) results.dkimDomains = [...(results.dkimDomains ?? []), domain]
    }
    if (result === 'pass' && method === 'spf') {
      const domain = /\bsmtp\.mailfrom\s*=\s*([^\s;]+)/iu.exec(entry)?.[1]?.toLowerCase().split('@').pop()
      if (domain) results.spfDomain = domain
    }
    // A message can carry several signatures: one good one counts, and one DMARC failure is a failure.
    if (!results[method] || result === (method === 'dmarc' ? 'fail' : 'pass')) results[method] = result
  }
  return results
}

const aligned = (domain: string, sender: string) => domain === sender || domain.endsWith(`.${sender}`) || sender.endsWith(`.${domain}`)

/**
 * A pass counts only for the domain the reader sees in From. Without DMARC, anyone can pass SPF
 * for their own domain while writing someone else's address, so an unaligned pass proves nothing.
 */
export function mailAuthVerdict(results: MailAuthResults | null | undefined, fromAddress: string): MailAuthVerdict {
  if (!results) return 'unverified'
  if (results.dmarc === 'fail') return 'failed'
  if (results.dmarc === 'pass') return 'verified'
  const sender = fromAddress.toLowerCase().split('@').pop() ?? ''
  if (!sender) return 'unverified'
  const pass = results.dkimDomains?.some(domain => aligned(domain, sender)) || (results.spfDomain && aligned(results.spfDomain, sender))
  return pass ? 'verified' : 'unverified'
}
