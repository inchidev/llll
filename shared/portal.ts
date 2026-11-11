/**
 * Portal: a Mac window shared into a conversation (ADR 0014). The Server holds a Portal's keys and relays the
 * host's and the guest's sockets frame for frame; what the guest may see or do is enforced on the host's Mac.
 */

/** The relay protocol the host speaks in its first frame (`{ t: 'host', key, v }`): one guest, frames passed verbatim. */
export const PORTAL_PROTOCOL = 1

/**
 * Relay protocol v2 (ADR 0014, stage 3): several viewers through a Realtime SFU. A host offers it with `v: 2`; the
 * Server answers `{ t: 'pp.ready', v: 2, sfu: true }` only when it has SFU credentials, and as v1 otherwise.
 */
export const PORTAL_PROTOCOL_SFU = 2

/** How many guests one Portal takes at once in v2. A guest beyond that is told so and closed with `full`. */
export const PORTAL_MAX_VIEWERS = 16

/** The picture's simulcast layers, as the host's Mac names them: full, half and quarter size. */
export const PORTAL_SFU_LAYERS = ['f', 'h', 'q'] as const
export type PortalSfuLayer = typeof PORTAL_SFU_LAYERS[number]

/** The layer a new viewer gets until it asks for another. */
export const PORTAL_SFU_DEFAULT_LAYER: PortalSfuLayer = 'h'

/** The host's publication: one video track and, when the Mac can make one, one audio track. */
export const PORTAL_SFU_TRACKS = ['video', 'audio'] as const

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
  /** v2: the Portal already has `PORTAL_MAX_VIEWERS` guests. The guest reads `PORTAL_FULL_BYE` first. */
  full: 4503,
} as const

/**
 * Messages of the Portal itself start with `pp.`: `pp.ready`, `pp.wait`, `pp.guest` from the Server, `pp.close`
 * from the host. In v1 a guest may not speak them; the Server drops a guest's `pp.` message instead of passing it
 * on. In v2 a guest's `pp.sfu.answer` and `pp.sfu.layer` are for the Server, and every frame between the host and a
 * guest is wrapped (`pp.from`, `pp.to`, `pp.all`).
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

/** What a guest beyond the last seat reads before its socket closes. */
export const PORTAL_FULL_BYE = JSON.stringify({ type: 'bye', final: true, reason: `This Portal already has ${PORTAL_MAX_VIEWERS} viewers. Try again when someone leaves.` })

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
