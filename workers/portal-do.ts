import { DurableObject } from 'cloudflare:workers'
import { PORTAL_AUTH_TIMEOUT_MS, PORTAL_CLOSE, PORTAL_PROTOCOL, portalLive, type PortalRecord } from '../shared/portal'
import { sha256Hex } from '../shared/server-settings'
import { portalOpenerMayKeep } from '../server/utils/portals'
import type { L4Env } from './env'

export type PortalRole = 'host' | 'guest'

/** What a socket carries across hibernation. `auth` is the guest's first frame, passed to every host that comes. */
type Attachment = { role: PortalRole, authed: boolean, replaced?: boolean, auth?: string }

export type PortalAuthVerdict = { ok: true } | { ok: false, code: number, reason: string }

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
    if (frame.v !== PORTAL_PROTOCOL) return { ok: false, code: PORTAL_CLOSE.protocol, reason: 'protocol' }
    return await sha256Hex(frame.key) === record.hostKeyHash ? { ok: true } : { ok: false, code: PORTAL_CLOSE.badKey, reason: 'bad_key' }
  }
  if (frame.t !== 'auth' || typeof frame.token !== 'string') return { ok: false, code: PORTAL_CLOSE.badFrame, reason: 'auth_required' }
  return await sha256Hex(frame.token) === record.guestKeyHash ? { ok: true } : { ok: false, code: PORTAL_CLOSE.badKey, reason: 'bad_key' }
}

/**
 * One Portal (ADR 0014): its record, the host's socket and one guest's socket. Frames pass through unread in
 * both directions once both sides have shown their keys. A newer host or guest replaces the older one.
 */
export class PortalDurableObject extends DurableObject<L4Env> {
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
    const other = me.role === 'host' ? this.current('guest') : this.current('host')
    if (other) this.send(other, raw)
  }

  override async webSocketClose(ws: WebSocket): Promise<void> {
    this.left(ws)
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    this.left(ws)
  }

  private left(ws: WebSocket) {
    const me = this.attachment(ws)
    if (!me?.authed || me.replaced) return
    // Mark it first: a close can be reported twice (error, then close).
    ws.serializeAttachment({ ...me, replaced: true } satisfies Attachment)
    if (me.role === 'guest') {
      const host = this.current('host')
      if (host) this.send(host, JSON.stringify({ t: 'pp.guest', open: false }))
      return
    }
    // The guest page reconnects on this close and waits for the next host.
    const guest = this.current('guest')
    if (guest) this.close(guest, PORTAL_CLOSE.hostLeft, 'host_left')
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
      const previous = this.current('host', ws)
      if (previous) this.replace(previous)
      ws.serializeAttachment({ role: 'host', authed: true } satisfies Attachment)
      this.send(ws, JSON.stringify({ t: 'pp.ready' }))
      const guest = this.current('guest')
      if (guest) this.introduce(ws, guest)
      return
    }
    const host = this.current('host')
    const previous = this.current('guest', ws)
    if (previous) {
      this.replace(previous)
      if (host) this.send(host, JSON.stringify({ t: 'pp.guest', open: false }))
    }
    ws.serializeAttachment({ role: 'guest', authed: true, auth: raw as string } satisfies Attachment)
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

  private replace(ws: WebSocket) {
    const me = this.attachment(ws)
    if (me) ws.serializeAttachment({ ...me, replaced: true } satisfies Attachment)
    this.close(ws, PORTAL_CLOSE.replaced, 'replaced')
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
