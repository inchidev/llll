import { DurableObject } from 'cloudflare:workers'
import {
  PORTAL_AUTH_TIMEOUT_MS, PORTAL_CLOSE, PORTAL_FULL_BYE, PORTAL_MAX_VIEWERS, PORTAL_PROTOCOL, PORTAL_PROTOCOL_SFU, PORTAL_REPLACED_BYE,
  PORTAL_SFU_DEFAULT_LAYER, PORTAL_SFU_LAYERS, PORTAL_SFU_TRACKS, portalLive, portalMessageType, type PortalRecord, type PortalSfuLayer,
} from '../shared/portal'
import { sha256Hex } from '../shared/server-settings'
import { portalOpenerMayKeep } from '../server/utils/portals'
import { portalIceServers, type IceServer } from '../server/utils/portal-turn'
import { failedTracks, portalSfu, portalSfuApp, SfuError, type PortalSfu, type SfuTrack } from '../server/utils/portal-sfu'
import type { L4Env } from './env'
import { createSerialQueue } from './serial-queue'

export type PortalRole = 'host' | 'guest'
type Version = typeof PORTAL_PROTOCOL | typeof PORTAL_PROTOCOL_SFU

/** A guest's subscription to the host's publication: its own SFU session and the mids of what it receives. */
type GuestSfu = { sessionId: string, mids: Record<string, string>, layer: PortalSfuLayer }

/**
 * What a socket carries across hibernation. `auth` is the guest's first frame, passed to every host that comes.
 * `v` is the protocol of a host connection. `g` names a guest in v2's wrapped frames; `admitted` says the host's Mac
 * accepted its key (`pp.admit`) and `sfu` is its subscription, both reset for every new host.
 */
type Attachment = {
  role: PortalRole
  authed: boolean
  replaced?: boolean
  auth?: string
  v?: Version
  g?: string
  admitted?: boolean
  sfu?: GuestSfu
  /** The layer a guest asked for before it had a subscription. */
  layer?: PortalSfuLayer
}

/** The host's publication on the SFU, kept while that host connection lasts. */
type SfuPublication = { sessionId: string, tracks: Array<{ trackName: string, kind: string }>, simulcast: boolean }

/** Every SFU session a Portal made, for Usage. */
export type PortalSfuSession = { id: string, role: PortalRole, g?: string, at: number }

export type PortalAuthVerdict = { ok: true } | { ok: false, code: number, reason: string }

/** A guest frame in v2 is small JSON: input, pings, an SDP answer. */
const GUEST_FRAME_MAX = 64 * 1024
const SDP_MAX = 128 * 1024
/** How long a guest has to answer the SFU's offer. */
const ANSWER_TIMEOUT_MS = 20_000
const SUBSCRIBE_ATTEMPTS = 4
const SESSIONS_KEPT = 500

/**
 * Check a socket's first frame. The host sends `{ t: 'host', key, v }`, the guest PartyPortal's own
 * `{ t: 'auth', token }`. Keys are compared by hash; the record holds no key.
 */
export async function portalAuthVerdict(record: PortalRecord | null, role: PortalRole, raw: string | ArrayBuffer, now = Date.now()): Promise<PortalAuthVerdict> {
  if (typeof raw !== 'string') return { ok: false, code: PORTAL_CLOSE.badFrame, reason: 'auth_required' }
  let frame: { t?: unknown, key?: unknown, token?: unknown, v?: unknown }
  try { frame = JSON.parse(raw) as typeof frame }
  catch { return { ok: false, code: PORTAL_CLOSE.badFrame, reason: 'bad_json' } }
  if (!portalLive(record, now)) return { ok: false, code: PORTAL_CLOSE.ended, reason: 'ended' }
  if (role === 'host') {
    if (frame.t !== 'host' || typeof frame.key !== 'string') return { ok: false, code: PORTAL_CLOSE.badFrame, reason: 'auth_required' }
    if (frame.v !== PORTAL_PROTOCOL && frame.v !== PORTAL_PROTOCOL_SFU) return { ok: false, code: PORTAL_CLOSE.protocol, reason: 'protocol' }
    return await sha256Hex(frame.key) === record.hostKeyHash ? { ok: true } : { ok: false, code: PORTAL_CLOSE.badKey, reason: 'bad_key' }
  }
  if (frame.t !== 'auth' || typeof frame.token !== 'string') return { ok: false, code: PORTAL_CLOSE.badFrame, reason: 'auth_required' }
  return await sha256Hex(frame.token) === record.guestKeyHash ? { ok: true } : { ok: false, code: PORTAL_CLOSE.badKey, reason: 'bad_key' }
}

/** The tracks a host may publish: `video` and optionally `audio`, each once, with the mid of its transceiver. */
export function portalPublishedTracks(raw: unknown): Array<{ mid: string, trackName: string, kind: string }> | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > PORTAL_SFU_TRACKS.length) return null
  const tracks: Array<{ mid: string, trackName: string, kind: string }> = []
  for (const item of raw as Array<Record<string, unknown>>) {
    const { mid, trackName, kind } = item ?? {}
    if (typeof mid !== 'string' || !mid || mid.length > 32) return null
    if (trackName !== 'video' && trackName !== 'audio') return null
    if (kind !== trackName) return null
    if (tracks.some(track => track.trackName === trackName || track.mid === mid)) return null
    tracks.push({ mid, trackName, kind: trackName })
  }
  return tracks.some(track => track.trackName === 'video') ? tracks : null
}

function parseObject(raw: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(raw) as unknown
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
  }
  catch { return null }
}

function guestId(): string {
  let binary = ''
  for (const byte of crypto.getRandomValues(new Uint8Array(6))) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_')
}

/**
 * One Portal (ADR 0014): its record, the host's socket and its guests' sockets.
 *
 * v1: one guest; frames pass through unread in both directions once both sides have shown their keys, and a newer
 * host or guest replaces the older one.
 *
 * v2 (a host that offers it, on a Server with a Realtime SFU app): up to `PORTAL_MAX_VIEWERS` guests. Every frame
 * between the host and a guest is wrapped (`pp.from`, `pp.to`, `pp.all`) so the Mac can tell guests apart and keep
 * its rules per guest. The host publishes its picture once (`pp.sfu.publish`); for each guest the Mac admits
 * (`pp.admit`) this object makes an SFU session that subscribes to it and hands the guest the SFU's offer. Media
 * never passes through here; every SFU call does, one at a time per session.
 */
export class PortalDurableObject extends DurableObject<L4Env> {
  /** SFU calls of one session (`host`, or `g:<guest>`) run one after another, offer and answer included. */
  private readonly queues = new Map<string, ReturnType<typeof createSerialQueue>>()
  /** A guest whose SFU offer is out: what to do with its answer, or with its leaving. */
  private readonly answers = new Map<string, { settle: (sdp: string) => Promise<void>, cancel: (why: string) => void }>()
  private readonly work = new Set<Promise<unknown>>()
  /** The ICE servers handed to the current host, for its guests' SFU connections too. */
  private ice: IceServer[] | null | undefined
  private sfuApi: PortalSfu | null = null
  /** Between attempts to subscribe a guest before the host's media has reached the SFU. */
  protected sfuRetryMs = 1000

  constructor(ctx: DurableObjectState, env: L4Env) {
    super(ctx, env)
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'))
  }

  async open(record: PortalRecord): Promise<void> {
    if (await this.record()) throw new Error('Portal exists')
    await this.ctx.storage.put('portal', record)
    await this.ctx.storage.setAlarm(record.expiresAt)
  }

  async record(): Promise<PortalRecord | null> {
    return (await this.ctx.storage.get<PortalRecord>('portal')) ?? null
  }

  /**
   * The SFU sessions this Portal made, oldest first.
   * TODO(L4 Cloud): Portal SFU egress is Usage. L4 Cloud reports it per Portal from here, as llll-cloud's
   * `portal_relay` meter (see docs/billing.md in llll-cloud); this object never sees the media, so it only keeps ids.
   */
  async sfuSessions(): Promise<PortalSfuSession[]> {
    return (await this.ctx.storage.get<PortalSfuSession[]>('sfu.sessions')) ?? []
  }

  async end(): Promise<void> {
    const record = await this.record()
    if (record && record.endedAt === null) await this.ctx.storage.put('portal', { ...record, endedAt: Date.now() })
    await this.ctx.storage.deleteAlarm()
    for (const ws of this.ctx.getWebSockets()) this.close(ws, PORTAL_CLOSE.ended, 'ended')
  }

  override async alarm(): Promise<void> {
    await this.end()
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected WebSocket', { status: 426 })
    const last = new URL(request.url).pathname.split('/').pop()
    const role: PortalRole | null = last === 'host' ? 'host' : last === 'ws' ? 'guest' : null
    if (!role) return new Response('Not found', { status: 404 })
    const pair = new WebSocketPair()
    this.ctx.acceptWebSocket(pair[1], [role])
    pair[1].serializeAttachment({ role, authed: false } satisfies Attachment)
    this.ctx.waitUntil(this.authTimeout(pair[1]))
    return new Response(null, { status: 101, webSocket: pair[0] })
  }

  override async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    const me = this.attachment(ws)
    if (!me) return
    if (!me.authed) {
      await this.authenticate(ws, me, raw)
      return
    }
    if (me.role === 'host' && me.v === PORTAL_PROTOCOL_SFU) return this.fromHostV2(ws, raw)
    if (me.role === 'guest') {
      const host = this.current('host')
      if (host && this.attachment(host)?.v === PORTAL_PROTOCOL_SFU) return this.fromGuestV2(ws, me, raw)
    }
    // v1. The Portal's own messages are not passed on: a guest may not speak them, and the host's are for the Server.
    const own = typeof raw === 'string' ? portalMessageType(raw) : null
    if (own) {
      if (me.role === 'host' && own === 'pp.close') {
        const guest = this.current('guest')
        if (guest) {
          this.replace(guest, PORTAL_CLOSE.closedByHost, 'closed_by_host')
          this.send(ws, JSON.stringify({ t: 'pp.guest', open: false }))
        }
      }
      return
    }
    const other = me.role === 'host' ? this.current('guest') : this.current('host')
    if (other) this.send(other, raw)
  }

  override async webSocketClose(ws: WebSocket): Promise<void> {
    await this.left(ws)
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    await this.left(ws)
  }

  /** Resolves once every SFU exchange started so far has finished (tests, and nothing else). */
  async settled(): Promise<void> {
    while (this.work.size) await Promise.allSettled([...this.work])
  }

  private async left(ws: WebSocket) {
    const me = this.attachment(ws)
    if (!me?.authed || me.replaced) return
    // Mark it first: a close can be reported twice (error, then close).
    ws.serializeAttachment({ ...me, replaced: true } satisfies Attachment)
    if (me.role === 'guest') {
      const host = this.current('host')
      const v2 = host && this.attachment(host)?.v === PORTAL_PROTOCOL_SFU
      if (host) this.send(host, JSON.stringify(v2 ? { t: 'pp.guest', open: false, g: me.g } : { t: 'pp.guest', open: false }))
      this.dropSubscription(me)
      return
    }
    // The guests stay and wait; their first frames are replayed to the next host that comes. A v2 host's publication
    // goes with it, and so does every subscription to it.
    if (me.v === PORTAL_PROTOCOL_SFU) await this.forgetPublication()
    for (const guest of this.guests()) this.send(guest, JSON.stringify({ t: 'pp.wait' }))
  }

  private async authenticate(ws: WebSocket, me: Attachment, raw: string | ArrayBuffer) {
    const record = await this.record()
    const verdict = await portalAuthVerdict(record, me.role, raw)
    if (!verdict.ok) {
      this.close(ws, verdict.code, verdict.reason)
      return
    }
    if (me.role === 'host') {
      // The person who opened the Portal must still be allowed to: access is rechecked on every host connection.
      if (!await portalOpenerMayKeep(this.env, record!)) {
        await this.end()
        return
      }
      // v2 only where this Server has an SFU app; otherwise the host is answered as v1 and keeps one guest.
      const offered = (JSON.parse(raw as string) as { v?: unknown }).v
      const app = offered === PORTAL_PROTOCOL_SFU ? await portalSfuApp(this.env).catch(() => null) : null
      const v: Version = app ? PORTAL_PROTOCOL_SFU : PORTAL_PROTOCOL
      const previous = this.current('host', ws)
      if (previous) this.replace(previous)
      // Whatever an earlier host published is gone; its guests are subscribed again once this host admits them.
      await this.forgetPublication()
      this.sfuApi = app ? portalSfu(app) : null
      ws.serializeAttachment({ role: 'host', authed: true, v } satisfies Attachment)
      await this.ctx.storage.put('mode', v)
      // TURN credentials for this connection, until the Portal ends; the Mac hands them to its guest in its hello,
      // and in v2 this object hands them to each guest with its SFU offer.
      const iceServers = await portalIceServers(this.env, (record!.expiresAt - Date.now()) / 1000).catch(() => null)
      this.ice = iceServers
      const ready = v === PORTAL_PROTOCOL_SFU ? { t: 'pp.ready', v, sfu: true } : { t: 'pp.ready' }
      this.send(ws, JSON.stringify(iceServers ? { ...ready, iceServers } : ready))
      const guests = this.guests()
      if (v === PORTAL_PROTOCOL_SFU) {
        for (const guest of guests) this.introduceV2(ws, guest)
        return
      }
      // v1 keeps one guest: the newest of those who waited.
      const newest = guests.at(-1)
      for (const guest of guests) {
        if (guest === newest) continue
        this.send(guest, PORTAL_REPLACED_BYE)
        this.replace(guest)
      }
      if (newest) this.introduce(ws, newest)
      return
    }
    const host = this.current('host')
    const mode = host ? this.attachment(host)?.v ?? PORTAL_PROTOCOL : (await this.ctx.storage.get<Version>('mode')) ?? PORTAL_PROTOCOL
    const g = guestId()
    if (mode === PORTAL_PROTOCOL_SFU) {
      if (this.guests(ws).length >= PORTAL_MAX_VIEWERS) {
        this.send(ws, PORTAL_FULL_BYE)
        this.close(ws, PORTAL_CLOSE.full, 'full')
        return
      }
      ws.serializeAttachment({ role: 'guest', authed: true, auth: raw as string, g } satisfies Attachment)
      if (host) this.introduceV2(host, ws)
      else this.send(ws, JSON.stringify({ t: 'pp.wait' }))
      return
    }
    for (const previous of this.guests(ws)) {
      this.send(previous, PORTAL_REPLACED_BYE)
      this.replace(previous)
      if (host) this.send(host, JSON.stringify({ t: 'pp.guest', open: false }))
    }
    ws.serializeAttachment({ role: 'guest', authed: true, auth: raw as string, g } satisfies Attachment)
    if (host) this.introduce(host, ws)
    else this.send(ws, JSON.stringify({ t: 'pp.wait' }))
  }

  /** Tell the host a guest is here and hand it the guest's own first frame, which the Mac checks again. */
  private introduce(host: WebSocket, guest: WebSocket) {
    const auth = this.attachment(guest)?.auth
    if (!auth) return
    this.send(host, JSON.stringify({ t: 'pp.guest', open: true }))
    this.send(host, auth)
  }

  /** The same in v2, where every guest has a name: `g`. */
  private introduceV2(host: WebSocket, guest: WebSocket) {
    const me = this.attachment(guest)
    const auth = me?.auth ? parseObject(me.auth) : null
    if (!me?.g || !auth) return
    this.send(host, JSON.stringify({ t: 'pp.guest', open: true, g: me.g }))
    this.send(host, JSON.stringify({ t: 'pp.from', g: me.g, f: auth }))
  }

  // MARK: v2

  private fromHostV2(host: WebSocket, raw: string | ArrayBuffer) {
    // No picture goes through a Portal in v2: binary frames from the host are dropped.
    if (typeof raw !== 'string') return
    const frame = parseObject(raw)
    if (!frame) return
    const g = typeof frame.g === 'string' ? frame.g : null
    const f = frame.f && typeof frame.f === 'object' && !Array.isArray(frame.f) ? JSON.stringify(frame.f) : null
    switch (frame.t) {
      case 'pp.to': {
        const guest = g ? this.guest(g) : null
        if (guest && f) this.send(guest, f)
        return
      }
      case 'pp.all':
        if (f) for (const guest of this.guests()) this.send(guest, f)
        return
      case 'pp.close': {
        const guest = g ? this.guest(g) : null
        if (!guest) return
        const me = this.attachment(guest)
        this.replace(guest, PORTAL_CLOSE.closedByHost, 'closed_by_host')
        if (me) this.dropSubscription(me)
        this.send(host, JSON.stringify({ t: 'pp.guest', open: false, g }))
        return
      }
      case 'pp.admit': {
        const guest = g ? this.guest(g) : null
        const me = guest && this.attachment(guest)
        if (!guest || !me || me.admitted) return
        guest.serializeAttachment({ ...me, admitted: true } satisfies Attachment)
        this.subscribe(guest)
        return
      }
      case 'pp.sfu.publish':
        this.publish(host, frame)
        return
      default:
        // Anything else is not for the Server, and a v2 host has no guest to pass it to unwrapped.
    }
  }

  private fromGuestV2(ws: WebSocket, me: Attachment, raw: string | ArrayBuffer) {
    if (typeof raw !== 'string' || raw.length > GUEST_FRAME_MAX || !me.g) return
    const frame = parseObject(raw)
    if (!frame) return
    if (typeof frame.t === 'string' && frame.t.startsWith('pp.')) {
      if (frame.t === 'pp.sfu.answer' && typeof frame.sdp === 'string' && frame.sdp.length < SDP_MAX) {
        const pending = this.answers.get(me.g)
        if (pending) this.track(pending.settle(frame.sdp).catch(() => {}))
      }
      else if (frame.t === 'pp.sfu.layer' && PORTAL_SFU_LAYERS.includes(frame.rid as PortalSfuLayer)) {
        this.setLayer(ws, frame.rid as PortalSfuLayer)
      }
      return
    }
    const host = this.current('host')
    if (host) this.send(host, JSON.stringify({ t: 'pp.from', g: me.g, f: frame }))
  }

  /** The host's offer for its picture (and sound): one SFU session, answered back to the host. */
  private publish(host: WebSocket, frame: Record<string, unknown>) {
    const tracks = portalPublishedTracks(frame.tracks)
    const sdp = typeof frame.sdp === 'string' && frame.sdp.length < SDP_MAX ? frame.sdp : null
    if (!tracks || !sdp) {
      this.send(host, JSON.stringify({ t: 'pp.sfu.error', why: 'bad_publish' }))
      return
    }
    this.track(this.inOrder('host', async () => {
      const sfu = await this.sfu()
      const sessionId = await sfu.newSession()
      await this.recordSession(sessionId, 'host')
      const result = await sfu.publish(sessionId, sdp, tracks)
      const failed = failedTracks(result)
      if (failed.some(track => track.trackName === 'video') || result.sessionDescription?.type !== 'answer') {
        throw new SfuError(failed[0]?.errorCode ?? 'no_answer', failed[0]?.errorDescription ?? 'the SFU did not take the picture')
      }
      if (this.current('host') !== host) return
      const published = tracks.filter(track => !failed.some(bad => bad.trackName === track.trackName))
      this.send(host, JSON.stringify({ t: 'pp.sfu.answer', sdp: result.sessionDescription.sdp, tracks: published.map(track => track.trackName) }))
      // A host that publishes again (its bridge reloaded) gets every admitted guest subscribed afresh.
      await this.ctx.storage.put('sfu.host', {
        sessionId, tracks: published.map(({ trackName, kind }) => ({ trackName, kind })), simulcast: /^a=simulcast:send /mu.test(sdp),
      } satisfies SfuPublication)
      for (const guest of this.guests()) if (this.attachment(guest)?.admitted) this.subscribe(guest)
    }).catch((error: unknown) => {
      if (this.current('host') === host) this.send(host, JSON.stringify({ t: 'pp.sfu.error', why: sfuWhy(error) }))
    }))
  }

  /** Give an admitted guest its own SFU session on the host's publication, and wait for its answer. */
  private subscribe(guest: WebSocket) {
    const g = this.attachment(guest)?.g
    if (!g) return
    this.track(this.inOrder(`g:${g}`, async () => {
      const published = await this.ctx.storage.get<SfuPublication>('sfu.host')
      const me = this.attachment(guest)
      if (!published || !me?.admitted || me.replaced || guest.readyState !== WebSocket.OPEN) return
      const sfu = await this.sfu()
      const layer = me.sfu?.layer ?? me.layer ?? PORTAL_SFU_DEFAULT_LAYER
      if (me.sfu) await this.closeSession(me.sfu)
      const remote: SfuTrack[] = published.tracks.map(track => ({
        location: 'remote', sessionId: published.sessionId, trackName: track.trackName, kind: track.kind,
        ...(track.trackName === 'video' && published.simulcast ? { simulcast: simulcast(layer) } : {}),
      }))
      // Right after the host published, its media may not have reached the SFU yet: try again a few times, then take
      // the picture without the sound rather than nothing.
      for (let attempt = 1; ; attempt++) {
        const sessionId = await sfu.newSession()
        await this.recordSession(sessionId, 'guest', g)
        const result = await sfu.pull(sessionId, remote)
        const ok = result.tracks.filter(track => !track.errorCode && track.mid)
        const offer = result.sessionDescription?.type === 'offer' ? result.sessionDescription.sdp : null
        if (offer && ok.some(track => track.trackName === 'video') && (ok.length === remote.length || attempt === SUBSCRIBE_ATTEMPTS)) {
          const current = this.attachment(guest)
          if (!current || current.replaced || await this.publicationChanged(published)) {
            await this.closeSession({ sessionId, mids: Object.fromEntries(ok.map(track => [track.trackName, track.mid!])), layer })
            return
          }
          const sub: GuestSfu = { sessionId, mids: Object.fromEntries(ok.map(track => [track.trackName, track.mid!])), layer }
          guest.serializeAttachment({ ...current, sfu: sub } satisfies Attachment)
          await this.offerAndWait(guest, g, sub, offer, ok, true)
          return
        }
        if (ok.length) await sfu.close(sessionId, ok.map(track => track.mid!)).catch(() => {})
        const failed = failedTracks(result)[0]
        if (attempt >= SUBSCRIBE_ATTEMPTS) throw new SfuError(failed?.errorCode ?? 'no_offer', failed?.errorDescription ?? 'no picture to subscribe to')
        await new Promise(resolve => setTimeout(resolve, this.sfuRetryMs * attempt))
        const again = this.attachment(guest)
        if (!again?.admitted || again.replaced || await this.publicationChanged(published)) return
      }
    }).catch((error: unknown) => {
      const why = sfuWhy(error)
      if (this.attachment(guest)?.replaced) return
      this.send(guest, JSON.stringify({ t: 'pp.sfu.error', why }))
      const host = this.current('host')
      if (host) this.send(host, JSON.stringify({ t: 'pp.sfu.error', g, why }))
    }))
  }

  /** Hand the guest the SFU's offer and hold this session's queue until its answer is accepted. */
  private async offerAndWait(guest: WebSocket, g: string, sub: GuestSfu, offer: string, tracks: SfuTrack[], fresh: boolean) {
    if (this.ice === undefined) {
      const record = await this.record()
      this.ice = record ? await portalIceServers(this.env, (record.expiresAt - Date.now()) / 1000).catch(() => null) : null
    }
    const sfu = await this.sfu()
    const answered = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.answers.delete(g)
        reject(new SfuError('no_answer', 'the guest did not answer the SFU'))
      }, ANSWER_TIMEOUT_MS)
      this.answers.set(g, {
        settle: async (sdp) => {
          clearTimeout(timer)
          this.answers.delete(g)
          try {
            await sfu.renegotiate(sub.sessionId, sdp)
            resolve()
          }
          catch (error) { reject(error) }
        },
        cancel: (why) => {
          clearTimeout(timer)
          this.answers.delete(g)
          reject(new SfuError('gone', why))
        },
      })
    })
    this.send(guest, JSON.stringify({
      t: 'pp.sfu.offer', sdp: offer, fresh,
      tracks: tracks.map(track => ({ mid: track.mid, trackName: track.trackName, kind: track.kind ?? track.trackName })),
      ...(this.ice ? { iceServers: this.ice } : {}),
    }))
    await answered
  }

  /** A guest asks for another layer of the picture: full, half or quarter size. */
  private setLayer(guest: WebSocket, rid: PortalSfuLayer) {
    const g = this.attachment(guest)?.g
    if (!g) return
    this.track(this.inOrder(`g:${g}`, async () => {
      const me = this.attachment(guest)
      const published = await this.ctx.storage.get<SfuPublication>('sfu.host')
      const mid = me?.sfu?.mids.video
      if (!me?.sfu || !mid || !published?.simulcast) {
        // Without a subscription yet, remember the choice for when it comes.
        if (me && !me.sfu) guest.serializeAttachment({ ...me, layer: rid } satisfies Attachment)
        this.send(guest, JSON.stringify({ t: 'pp.sfu.layer', rid, ok: false }))
        return
      }
      const result = await (await this.sfu()).update(me.sfu.sessionId, [
        { location: 'remote', sessionId: published.sessionId, trackName: 'video', mid, simulcast: simulcast(rid) },
      ])
      if (failedTracks(result).length) {
        this.send(guest, JSON.stringify({ t: 'pp.sfu.layer', rid, ok: false }))
        return
      }
      const sub = { ...me.sfu, layer: rid }
      guest.serializeAttachment({ ...me, sfu: sub } satisfies Attachment)
      if (result.requiresImmediateRenegotiation && result.sessionDescription?.type === 'offer') {
        await this.offerAndWait(guest, g, sub, result.sessionDescription.sdp, result.tracks, false)
      }
      this.send(guest, JSON.stringify({ t: 'pp.sfu.layer', rid, ok: true }))
    }).catch(() => this.send(guest, JSON.stringify({ t: 'pp.sfu.layer', rid, ok: false }))))
  }

  /** The host's publication is gone (it left, or a new host came): so is every subscription to it. */
  private async forgetPublication() {
    await this.ctx.storage.delete('sfu.host')
    for (const guest of this.guests()) {
      const me = this.attachment(guest)
      if (!me) continue
      this.dropSubscription(me)
      guest.serializeAttachment({ ...me, admitted: false, sfu: undefined } satisfies Attachment)
    }
  }

  /** Stop waiting for this guest's answer and close its SFU session, in its own queue. */
  private dropSubscription(me: Attachment) {
    if (!me.g) return
    this.answers.get(me.g)?.cancel('the guest or the host left')
    const sub = me.sfu
    if (!sub) return
    this.track(this.inOrder(`g:${me.g}`, () => this.closeSession(sub)).catch(() => {}))
  }

  private async closeSession(sub: GuestSfu) {
    const mids = Object.values(sub.mids)
    if (mids.length) await (await this.sfu()).close(sub.sessionId, mids).catch(() => {})
  }

  private async publicationChanged(published: SfuPublication): Promise<boolean> {
    return (await this.ctx.storage.get<SfuPublication>('sfu.host'))?.sessionId !== published.sessionId
  }

  private async recordSession(id: string, role: PortalRole, g?: string) {
    const sessions = await this.sfuSessions()
    sessions.push({ id, role, ...(g ? { g } : {}), at: Date.now() })
    await this.ctx.storage.put('sfu.sessions', sessions.slice(-SESSIONS_KEPT))
  }

  /** The SFU client of a v2 host. Kept in memory only: after hibernation it is made again from the app. */
  private async sfu(): Promise<PortalSfu> {
    if (!this.sfuApi) {
      const app = await portalSfuApp(this.env).catch(() => null)
      if (!app) throw new SfuError('no_app', 'this Server has no SFU app')
      this.sfuApi = portalSfu(app)
    }
    return this.sfuApi
  }

  private inOrder<T>(key: string, task: () => Promise<T>): Promise<T> {
    let queue = this.queues.get(key)
    if (!queue) {
      queue = createSerialQueue()
      this.queues.set(key, queue)
    }
    return queue(task)
  }

  private track(promise: Promise<unknown>) {
    this.work.add(promise)
    void promise.finally(() => this.work.delete(promise))
  }

  // MARK: sockets

  private replace(ws: WebSocket, code: number = PORTAL_CLOSE.replaced, reason = 'replaced') {
    const me = this.attachment(ws)
    if (me) ws.serializeAttachment({ ...me, replaced: true } satisfies Attachment)
    this.close(ws, code, reason)
  }

  /** The authenticated socket of a role that is still open, other than `except`. */
  private current(role: PortalRole, except?: WebSocket): WebSocket | null {
    for (const ws of this.ctx.getWebSockets(role)) {
      if (ws === except || ws.readyState !== WebSocket.OPEN) continue
      const attachment = this.attachment(ws)
      if (attachment?.authed && !attachment.replaced) return ws
    }
    return null
  }

  /** Every authenticated guest still open, oldest first, other than `except`. */
  private guests(except?: WebSocket): WebSocket[] {
    return this.ctx.getWebSockets('guest').filter((ws) => {
      if (ws === except || ws.readyState !== WebSocket.OPEN) return false
      const attachment = this.attachment(ws)
      return Boolean(attachment?.authed && !attachment.replaced)
    })
  }

  private guest(g: string): WebSocket | null {
    return this.guests().find(ws => this.attachment(ws)?.g === g) ?? null
  }

  private attachment(ws: WebSocket): Attachment | null {
    return (ws.deserializeAttachment() as Attachment | null) ?? null
  }

  private async authTimeout(ws: WebSocket) {
    await new Promise(resolve => setTimeout(resolve, PORTAL_AUTH_TIMEOUT_MS))
    if (!this.attachment(ws)?.authed) this.close(ws, PORTAL_CLOSE.badFrame, 'auth_timeout')
  }

  private send(ws: WebSocket, data: string | ArrayBuffer) {
    try { ws.send(data) }
    catch { /* The socket closed in between; its close handler tidies up. */ }
  }

  private close(ws: WebSocket, code: number, reason: string) {
    try { ws.close(code, reason) }
    catch { /* Already closed. */ }
  }
}

function simulcast(rid: PortalSfuLayer) {
  return { preferredRid: rid, priorityOrdering: 'asciibetical', ridNotAvailable: 'asciibetical' } as const
}

/** What a host or guest is told about a failed SFU call: the SFU's code, never its full text or our credentials. */
function sfuWhy(error: unknown): string {
  return error instanceof SfuError ? error.code : 'sfu_failed'
}
