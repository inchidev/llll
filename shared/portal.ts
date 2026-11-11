/**
 * Portal: a Mac window shared into a conversation (ADR 0014). The Server holds a Portal's keys and relays the
 * host's and the guest's sockets frame for frame; what the guest may see or do is enforced on the host's Mac.
 */

/** The relay protocol the host speaks in its first frame (`{ t: 'host', key, v }`). */
export const PORTAL_PROTOCOL = 1

/** A Portal ends this long after it was opened, if nobody ends it earlier. */
export const PORTAL_LIFETIME_MS = 12 * 60 * 60 * 1000

/** A socket that has not authenticated by then is closed. */
export const PORTAL_AUTH_TIMEOUT_MS = 10_000

/** Close codes both sides read. The host stops reconnecting on 4401, 4404, 4409 and 4426. */
export const PORTAL_CLOSE = {
  badFrame: 4400,
  badKey: 4401,
  ended: 4404,
  replaced: 4409,
  protocol: 4426,
  /** The host asked the Server to close its guest (`{ t: 'pp.close' }`), after its own `bye`. */
  closedByHost: 4403,
} as const

/**
 * Messages of the Portal itself start with `pp.`: `pp.ready`, `pp.wait`, `pp.guest` from the Server, `pp.close`
 * from the host. A guest may not speak them; the Server drops a guest's `pp.` message instead of passing it on.
 */
export function portalMessageType(raw: string): string | null {
  if (!raw.includes('"pp.')) return null
  try {
    const frame = JSON.parse(raw) as { t?: unknown }
    return typeof frame?.t === 'string' && frame.t.startsWith('pp.') ? frame.t : null
  }
  catch { return null }
}

/** What a replaced guest's page reads, in PartyPortal's own words, so two pages do not keep pushing each other out. */
export const PORTAL_REPLACED_BYE = JSON.stringify({ type: 'bye', final: true, reason: 'This link was opened somewhere else.' })

/** A Portal's id is a UUID (v7), as every id on a Server. */
export const PORTAL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u

/** The host's and the guest's sockets; the Worker entry hands them to the Portal before Nitro sees them. */
export const PORTAL_SOCKET_PATH = /^\/portal\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/(?:ws|host)$/u

export type PortalRecord = {
  id: string
  channelId: string
  createdBy: string
  createdAt: number
  expiresAt: number
  /** SHA-256 hex of the keys; the keys themselves are given out once and never stored. */
  hostKeyHash: string
  guestKeyHash: string
  endedAt: number | null
}

export type OpenedPortal = {
  portalId: string
  /** The page guests open, without its key. */
  url: string
  /** The page with the guest key in its fragment: what the host sends to a guest. */
  guestUrl: string
  /** Opens the PartyPortal app on the host's Mac and connects it to this Portal. */
  hostLink: string
  expiresAt: string
}

export function portalLive(record: PortalRecord | null, now = Date.now()): record is PortalRecord {
  return Boolean(record && record.endedAt === null && record.expiresAt > now)
}

/** The links of one Portal on one Server address. */
export function portalLinks(origin: string, portalId: string, keys: { host: string, guest: string }) {
  const url = `${origin.replace(/\/$/u, '')}/portal/${portalId}`
  const query = new URLSearchParams({ url, key: keys.host, t: keys.guest })
  return { url, guestUrl: `${url}#t=${keys.guest}`, hostLink: `partyportal://portal?${query.toString()}` }
}
