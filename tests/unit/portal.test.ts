import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PORTAL_CLOSE, PORTAL_FULL_BYE, PORTAL_MAX_VIEWERS, PORTAL_PROTOCOL, PORTAL_PROTOCOL_SFU, portalLinks, portalLive, type PortalRecord } from '../../shared/portal'
import { sha256Hex } from '../../shared/server-settings'
import { PORTAL_GUEST_HTML } from '../../server/utils/portal-guest-page'

vi.mock('cloudflare:workers', () => ({ DurableObject: class { constructor(protected ctx: unknown, protected env: unknown) {} } }))
const mayKeep = vi.fn(async () => true)
vi.mock('../../server/utils/portals', () => ({ portalOpenerMayKeep: (...args: unknown[]) => mayKeep(...args as []) }))
const iceServers = vi.fn(async (): Promise<unknown> => null)
vi.mock('../../server/utils/portal-turn', () => ({ portalIceServers: (...args: unknown[]) => iceServers(...args as []) }))
const sfuApp = vi.fn(async (): Promise<unknown> => null)
/** The SFU's Connection API as the Durable Object reaches it; set per test. */
let sfuTransport: typeof fetch = async () => new Response('no SFU in this test', { status: 500 })
vi.mock('../../server/utils/portal-sfu', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../server/utils/portal-sfu')>()
  return {
    ...real,
    portalSfuApp: (...args: unknown[]) => sfuApp(...args as []),
    portalSfu: (app: { appId: string, appToken: string }) => real.portalSfu(app, ((...args: Parameters<typeof fetch>) => sfuTransport(...args)) as typeof fetch),
  }
})
vi.stubGlobal('WebSocketRequestResponsePair', class { constructor(readonly request: string, readonly response: string) {} })

const { PortalDurableObject, portalAuthVerdict } = await import('../../workers/portal-do')

const HOST_KEY = 'host-key-0123456789'
const GUEST_KEY = 'guest-key-0123456789'

async function record(overrides: Partial<PortalRecord> = {}): Promise<PortalRecord> {
  return {
    id: '0190c3c2-1b2a-7c3d-8e4f-0123456789ab',
    channelId: 'channel-1',
    createdBy: 'user-1',
    createdAt: 1_000,
    expiresAt: Date.now() + 60_000,
    hostKeyHash: await sha256Hex(HOST_KEY),
    guestKeyHash: await sha256Hex(GUEST_KEY),
    endedAt: null,
    ...overrides,
  }
}

/** A socket as the Durable Object sees it: what it was sent, how it was closed, and its attachment. */
class FakeSocket {
  sent: Array<string | ArrayBuffer> = []
  closed: { code: number, reason: string } | null = null
  readyState = 1
  private attachment: unknown = null
  constructor(readonly tags: string[]) {}
  send(data: string | ArrayBuffer) { if (this.readyState !== 1) throw new Error('closed'); this.sent.push(data) }
  close(code: number, reason: string) { this.closed = { code, reason }; this.readyState = 3 }
  serializeAttachment(value: unknown) { this.attachment = structuredClone(value) }
  deserializeAttachment() { return this.attachment }
  frames() { return this.sent.filter((frame): frame is string => typeof frame === 'string').map(frame => JSON.parse(frame) as Record<string, unknown>) }
}

function room() {
  const storage = new Map<string, unknown>()
  const sockets: FakeSocket[] = []
  const ctx = {
    storage: {
      get: async (key: string) => storage.get(key),
      put: async (key: string, value: unknown) => { storage.set(key, structuredClone(value)) },
      delete: async (key: string) => storage.delete(key),
      setAlarm: async () => {},
      deleteAlarm: async () => {},
    },
    acceptWebSocket: (ws: FakeSocket, tags: string[]) => { ws.tags.push(...tags); sockets.push(ws) },
    getWebSockets: (tag?: string) => sockets.filter(ws => !tag || ws.tags.includes(tag)),
    setWebSocketAutoResponse: () => {},
    waitUntil: () => {},
  }
  const portal = new PortalDurableObject(ctx as never, {} as never)
  ;(portal as unknown as { sfuRetryMs: number }).sfuRetryMs = 1
  /** What `fetch` does for an upgrade, without a WebSocketPair. */
  const connect = (role: 'host' | 'guest') => {
    const ws = new FakeSocket([])
    ctx.acceptWebSocket(ws, [role])
    ws.serializeAttachment({ role, authed: false })
    return ws
  }
  const say = (ws: FakeSocket, frame: unknown) => portal.webSocketMessage(ws as never, typeof frame === 'string' || frame instanceof ArrayBuffer ? frame : JSON.stringify(frame))
  return { portal, connect, say, storage }
}

const hostHello = { t: 'host', key: HOST_KEY, v: PORTAL_PROTOCOL }
const guestHello = { t: 'auth', token: GUEST_KEY }

beforeEach(() => {
  mayKeep.mockReset()
  mayKeep.mockResolvedValue(true)
  iceServers.mockReset()
  iceServers.mockResolvedValue(null)
  sfuApp.mockReset()
  sfuApp.mockResolvedValue(null)
})

describe('portal links', () => {
  it('keeps the guest key in the fragment and both keys out of the page URL', () => {
    const links = portalLinks('https://acme.example/', 'abc', { host: 'H', guest: 'G' })
    expect(links.url).toBe('https://acme.example/portal/abc')
    expect(links.guestUrl).toBe('https://acme.example/portal/abc#t=G')
    const host = new URL(links.hostLink)
    expect(host.protocol).toBe('partyportal:')
    expect(host.searchParams.get('url')).toBe(links.url)
    expect(host.searchParams.get('key')).toBe('H')
    expect(host.searchParams.get('t')).toBe('G')
  })

  it('is live until it ends or expires', async () => {
    expect(portalLive(await record())).toBe(true)
    expect(portalLive(await record({ endedAt: 5 }))).toBe(false)
    expect(portalLive(await record({ expiresAt: 10 }), 11)).toBe(false)
    expect(portalLive(null)).toBe(false)
  })
})

describe('first frames', () => {
  it('admits the host and the guest only with their own keys', async () => {
    const live = await record()
    expect(await portalAuthVerdict(live, 'host', JSON.stringify(hostHello))).toEqual({ ok: true })
    expect(await portalAuthVerdict(live, 'guest', JSON.stringify(guestHello))).toEqual({ ok: true })
    // Each key opens only its own side.
    expect(await portalAuthVerdict(live, 'host', JSON.stringify({ ...hostHello, key: GUEST_KEY }))).toMatchObject({ code: PORTAL_CLOSE.badKey })
    expect(await portalAuthVerdict(live, 'guest', JSON.stringify({ t: 'auth', token: HOST_KEY }))).toMatchObject({ code: PORTAL_CLOSE.badKey })
  })

  it('refuses another protocol, an ended Portal and frames that are not a greeting', async () => {
    const live = await record()
    expect(await portalAuthVerdict(live, 'host', JSON.stringify({ ...hostHello, v: 99 }))).toMatchObject({ code: PORTAL_CLOSE.protocol })
    expect(await portalAuthVerdict(await record({ endedAt: 1 }), 'guest', JSON.stringify(guestHello))).toMatchObject({ code: PORTAL_CLOSE.ended })
    expect(await portalAuthVerdict(live, 'guest', new ArrayBuffer(4))).toMatchObject({ code: PORTAL_CLOSE.badFrame })
    expect(await portalAuthVerdict(live, 'guest', '{nope')).toMatchObject({ code: PORTAL_CLOSE.badFrame })
    expect(await portalAuthVerdict(live, 'host', JSON.stringify(guestHello))).toMatchObject({ code: PORTAL_CLOSE.badFrame })
  })
})

describe('the relay', () => {
  it('introduces a waiting guest to the host and then passes frames both ways untouched', async () => {
    const { portal, connect, say } = room()
    await portal.open(await record())
    const guest = connect('guest')
    await say(guest, guestHello)
    expect(guest.frames()).toEqual([{ t: 'pp.wait' }])

    const host = connect('host')
    await say(host, hostHello)
    expect(host.frames()).toEqual([{ t: 'pp.ready' }, { t: 'pp.guest', open: true }, guestHello])

    await say(guest, { t: 'm', x: 0.5, y: 0.5 })
    const video = new Uint8Array([1, 1, 0, 0, 0, 0, 0, 0, 0, 7]).buffer
    await say(host, video)
    expect(host.frames().at(-1)).toEqual({ t: 'm', x: 0.5, y: 0.5 })
    expect(guest.sent.at(-1)).toBe(video)
  })

  it('tells the host when the guest leaves or is replaced, and keeps one guest', async () => {
    const { portal, connect, say } = room()
    await portal.open(await record())
    const host = connect('host')
    await say(host, hostHello)
    const first = connect('guest')
    await say(first, guestHello)
    const second = connect('guest')
    await say(second, guestHello)
    expect(first.closed?.code).toBe(PORTAL_CLOSE.replaced)
    expect(first.frames().at(-1)).toEqual({ type: 'bye', final: true, reason: 'This link was opened somewhere else.' })
    // The replaced guest's late close is not reported as the new guest leaving.
    await portal.webSocketClose(first as never)
    expect(host.frames().filter(frame => frame.t === 'pp.guest')).toEqual([{ t: 'pp.guest', open: true }, { t: 'pp.guest', open: false }, { t: 'pp.guest', open: true }])
    await portal.webSocketClose(second as never)
    expect(host.frames().at(-1)).toEqual({ t: 'pp.guest', open: false })
  })

  it('keeps the guest waiting when the host leaves and introduces it to the next host', async () => {
    const { portal, connect, say } = room()
    await portal.open(await record())
    const host = connect('host')
    await say(host, hostHello)
    const guest = connect('guest')
    await say(guest, guestHello)
    host.close(1006, 'gone')
    await portal.webSocketClose(host as never)
    expect(guest.closed).toBeNull()
    expect(guest.frames().at(-1)).toEqual({ t: 'pp.wait' })
    const next = connect('host')
    await say(next, hostHello)
    expect(next.frames()).toEqual([{ t: 'pp.ready' }, { t: 'pp.guest', open: true }, guestHello])
  })

  it('drops the Portal\'s own messages from a guest and lets the host close its guest', async () => {
    const { portal, connect, say } = room()
    await portal.open(await record())
    const host = connect('host')
    await say(host, hostHello)
    const guest = connect('guest')
    await say(guest, guestHello)
    const before = host.frames().length
    await say(guest, { t: 'pp.guest', open: false })
    expect(host.frames()).toHaveLength(before)
    await say(host, { type: 'bye', final: true, reason: 'The host closed access.' })
    await say(host, { t: 'pp.close' })
    expect(guest.frames().at(-1)).toEqual({ type: 'bye', final: true, reason: 'The host closed access.' })
    expect(guest.closed?.code).toBe(PORTAL_CLOSE.closedByHost)
    expect(host.frames().at(-1)).toEqual({ t: 'pp.guest', open: false })
  })

  it('gives the host TURN credentials when the Server has them, and keeps going without', async () => {
    const turn = [{ urls: ['turn:turn.cloudflare.com:3478?transport=udp'], username: 'u', credential: 'c' }]
    iceServers.mockResolvedValueOnce(turn)
    const { portal, connect, say } = room()
    await portal.open(await record())
    const host = connect('host')
    await say(host, hostHello)
    expect(host.frames()[0]).toEqual({ t: 'pp.ready', iceServers: turn })
    iceServers.mockRejectedValueOnce(new Error('Cloudflare is down'))
    const next = connect('host')
    await say(next, hostHello)
    expect(next.frames()[0]).toEqual({ t: 'pp.ready' })
  })

  it('passes nothing before both keys are shown', async () => {
    const { portal, connect, say } = room()
    await portal.open(await record())
    const host = connect('host')
    await say(host, hostHello)
    const stranger = connect('guest')
    await say(stranger, { t: 'auth', token: 'wrong' })
    expect(stranger.closed?.code).toBe(PORTAL_CLOSE.badKey)
    expect(host.frames()).toEqual([{ t: 'pp.ready' }])
  })

  it('ends the Portal when the person who opened it may no longer keep it', async () => {
    const { portal, connect, say } = room()
    await portal.open(await record())
    mayKeep.mockResolvedValue(false)
    const host = connect('host')
    await say(host, hostHello)
    expect(host.closed?.code).toBe(PORTAL_CLOSE.ended)
    expect((await portal.record())?.endedAt).not.toBeNull()
  })

  it('closes everyone when it ends, and a new host is refused after', async () => {
    const { portal, connect, say } = room()
    await portal.open(await record())
    const host = connect('host')
    await say(host, hostHello)
    const guest = connect('guest')
    await say(guest, guestHello)
    await portal.end()
    expect(host.closed?.code).toBe(PORTAL_CLOSE.ended)
    expect(guest.closed?.code).toBe(PORTAL_CLOSE.ended)
    const late = connect('host')
    await say(late, hostHello)
    expect(late.closed?.code).toBe(PORTAL_CLOSE.ended)
  })

  it('refuses to open the same Portal twice', async () => {
    const { portal } = room()
    await portal.open(await record())
    await expect(portal.open(await record())).rejects.toThrow()
  })
})

/**
 * A stand-in for the SFU's Connection API. It answers like the real one and refuses, as the real one does with a 406,
 * a mutation on a session whose offer has not been answered yet; `overlaps` counts those.
 */
class FakeSfu {
  calls: string[] = []
  overlaps = 0
  sessions = 0
  /** Remote pulls that fail before the host's media arrives. */
  failPulls = 0
  private unanswered = new Set<string>()
  private busy = new Set<string>()

  transport = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url).replace('https://rtc.live.cloudflare.com/v1/apps/APP', '')
    type Track = { trackName?: string, mid?: string, sessionId?: string, simulcast?: { preferredRid: string } }
    const body = (init?.body ? JSON.parse(String(init.body)) : {}) as { tracks?: Track[], sessionDescription?: { sdp: string } }
    const session = path.match(/^\/sessions\/([^/]+)\//u)?.[1]
    if (session) {
      if (this.busy.has(session)) this.overlaps++
      this.busy.add(session)
    }
    await new Promise(resolve => setTimeout(resolve, 2))
    try {
      if (path === '/sessions/new') {
        this.calls.push('new')
        return Response.json({ sessionId: `S${++this.sessions}` }, { status: 201 })
      }
      if (session && this.unanswered.has(session) && !path.endsWith('/renegotiate') && !path.endsWith('/tracks/close')) {
        this.overlaps++
        return Response.json({ errorCode: 'invalid_params', errorDescription: 'pending negotiation' }, { status: 406 })
      }
      const tracks = body.tracks ?? []
      if (path.endsWith('/tracks/new') && body.sessionDescription) {
        this.calls.push(`${session} publish ${tracks.map(t => `${t.trackName}@${t.mid}`).join(',')}`)
        return Response.json({ sessionDescription: { type: 'answer', sdp: `answer:${session}` }, tracks })
      }
      if (path.endsWith('/tracks/new')) {
        this.calls.push(`${session} pull ${tracks.map(t => `${t.sessionId}/${t.trackName}${t.simulcast ? `:${t.simulcast.preferredRid}` : ''}`).join(',')}`)
        if (this.failPulls > 0) {
          this.failPulls--
          return Response.json({ tracks: tracks.map(t => ({ ...t, errorCode: 'not_found_track_error', errorDescription: 'not yet' })) })
        }
        this.unanswered.add(session!)
        return Response.json({
          requiresImmediateRenegotiation: true,
          sessionDescription: { type: 'offer', sdp: `offer:${session}` },
          tracks: tracks.map((t, i) => ({ ...t, mid: String(i) })),
        })
      }
      if (path.endsWith('/renegotiate')) {
        this.calls.push(`${session} renegotiate ${body.sessionDescription?.sdp}`)
        this.unanswered.delete(session!)
        return Response.json({})
      }
      if (path.endsWith('/tracks/update')) {
        this.calls.push(`${session} update ${tracks.map(t => `${t.mid}:${t.simulcast?.preferredRid}`).join(',')}`)
        return Response.json({ requiresImmediateRenegotiation: false, tracks })
      }
      if (path.endsWith('/tracks/close')) {
        this.calls.push(`${session} close ${tracks.map(t => t.mid).join(',')}`)
        this.unanswered.delete(session!)
        return Response.json({ tracks })
      }
      return Response.json({ errorCode: 'not_found' }, { status: 404 })
    }
    finally { if (session) this.busy.delete(session) }
  }) as typeof fetch
}

const hostV2 = { ...hostHello, v: PORTAL_PROTOCOL_SFU }

/** Wait until a socket has been handed an SFU offer. */
async function offered(ws: FakeSocket) {
  for (let i = 0; i < 500 && !ws.frames().some(frame => frame.t === 'pp.sfu.offer'); i++) await new Promise(resolve => setTimeout(resolve, 2))
}
const publish = { t: 'pp.sfu.publish', sdp: 'v=0\r\na=simulcast:send f;h;q\r\n', tracks: [{ mid: '0', trackName: 'video', kind: 'video' }, { mid: '1', trackName: 'audio', kind: 'audio' }] }

/** A v2 Portal with a host on it, the SFU stand-in, and a way to bring guests in. */
async function v2room() {
  const sfu = new FakeSfu()
  sfuTransport = sfu.transport
  sfuApp.mockResolvedValue({ appId: 'APP', appToken: 'TOKEN' })
  const r = room()
  await r.portal.open(await record())
  const host = r.connect('host')
  await r.say(host, hostV2)
  const join = async () => {
    const guest = r.connect('guest')
    await r.say(guest, guestHello)
    const g = (host.frames().filter(frame => frame.t === 'pp.guest' && frame.open).at(-1) as { g: string }).g
    return { guest, g }
  }
  return { ...r, sfu, host, join }
}

describe('relay protocol v2 (several viewers through the SFU)', () => {
  it('is spoken only when the host offers it and the Server has an SFU app; otherwise the host gets v1', async () => {
    const { portal, connect, say } = room()
    await portal.open(await record())
    const plain = connect('host')
    await say(plain, hostV2)
    expect(plain.frames()).toEqual([{ t: 'pp.ready' }])
    // Answered as v1: one guest, frames verbatim.
    const guest = connect('guest')
    await say(guest, guestHello)
    expect(plain.frames().slice(1)).toEqual([{ t: 'pp.guest', open: true }, guestHello])
    await say(guest, { t: 'm', x: 1, y: 1 })
    expect(plain.frames().at(-1)).toEqual({ t: 'm', x: 1, y: 1 })

    sfuApp.mockResolvedValue({ appId: 'APP', appToken: 'TOKEN' })
    iceServers.mockResolvedValue([{ urls: ['turn:turn.cloudflare.com:3478'], username: 'u', credential: 'c' }])
    const v2 = connect('host')
    await say(v2, hostV2)
    expect(plain.closed?.code).toBe(PORTAL_CLOSE.replaced)
    expect(v2.frames()[0]).toEqual({ t: 'pp.ready', v: 2, sfu: true, iceServers: [{ urls: ['turn:turn.cloudflare.com:3478'], username: 'u', credential: 'c' }] })
    // A v1 host never makes the Server look for an SFU app.
    sfuApp.mockClear()
    await say(connect('host'), hostHello)
    expect(sfuApp).not.toHaveBeenCalled()
  })

  it('takes many guests, names each, and wraps frames both ways', async () => {
    const { say, host, join } = await v2room()
    const a = await join()
    const b = await join()
    expect(a.g).toMatch(/^[\w-]{8}$/u)
    expect(a.g).not.toBe(b.g)
    expect(a.guest.closed).toBeNull()
    expect(host.frames().slice(1)).toEqual([
      { t: 'pp.guest', open: true, g: a.g }, { t: 'pp.from', g: a.g, f: guestHello },
      { t: 'pp.guest', open: true, g: b.g }, { t: 'pp.from', g: b.g, f: guestHello },
    ])
    await say(b.guest, { t: 'control', ask: true })
    expect(host.frames().at(-1)).toEqual({ t: 'pp.from', g: b.g, f: { t: 'control', ask: true } })
    await say(host, { t: 'pp.to', g: a.g, f: { type: 'hello', sfu: true } })
    await say(host, { t: 'pp.all', f: { type: 'state', sharing: true } })
    expect(a.guest.frames()).toEqual([{ type: 'hello', sfu: true }, { type: 'state', sharing: true }])
    expect(b.guest.frames()).toEqual([{ type: 'state', sharing: true }])
    // No picture goes through the Portal in v2, and nothing unwrapped either.
    const before = a.guest.sent.length
    await say(host, new Uint8Array([1, 1, 0]).buffer)
    await say(host, { type: 'state' })
    expect(a.guest.sent).toHaveLength(before)
    // A guest's own pp. frames other than its SFU answer and layer go nowhere.
    const heard = host.sent.length
    await say(a.guest, { t: 'pp.close', g: b.g })
    await say(a.guest, { t: 'pp.admit', g: a.g })
    expect(host.sent).toHaveLength(heard)
    expect(b.guest.closed).toBeNull()
  })

  it('lets the host close one guest and reports each guest leaving by name', async () => {
    const { portal, say, host, join } = await v2room()
    const a = await join()
    const b = await join()
    await say(host, { t: 'pp.to', g: a.g, f: { type: 'bye', final: true, reason: 'The host closed access.' } })
    await say(host, { t: 'pp.close', g: a.g })
    expect(a.guest.closed?.code).toBe(PORTAL_CLOSE.closedByHost)
    expect(host.frames().at(-1)).toEqual({ t: 'pp.guest', open: false, g: a.g })
    await portal.webSocketClose(a.guest as never)
    expect(host.frames().filter(frame => frame.open === false)).toHaveLength(1)
    await portal.webSocketClose(b.guest as never)
    expect(host.frames().at(-1)).toEqual({ t: 'pp.guest', open: false, g: b.g })
  })

  it(`seats ${PORTAL_MAX_VIEWERS} guests and turns away the next with a clear word`, async () => {
    const { connect, say, join } = await v2room()
    for (let i = 0; i < PORTAL_MAX_VIEWERS; i++) await join()
    const late = connect('guest')
    await say(late, guestHello)
    expect(late.sent).toEqual([PORTAL_FULL_BYE])
    expect(late.closed?.code).toBe(PORTAL_CLOSE.full)
  })

  it('publishes the host once and subscribes each admitted guest in its own session, answer before anything else', async () => {
    iceServers.mockResolvedValue([{ urls: ['turn:t'], username: 'u', credential: 'c' }])
    const { portal, say, host, join, sfu } = await v2room()
    const a = await join()
    // Not admitted yet: nothing is subscribed before the Mac has checked the guest's key.
    await say(host, publish)
    await portal.settled()
    expect(host.frames().at(-1)).toEqual({ t: 'pp.sfu.answer', sdp: 'answer:S1', tracks: ['video', 'audio'] })
    expect(sfu.calls).toEqual(['new', 'S1 publish video@0,audio@1'])
    expect(a.guest.frames()).toEqual([])

    await say(host, { t: 'pp.admit', g: a.g })
    // The guest asks for another layer before it has even answered: the update waits for its answer.
    await say(a.guest, { t: 'pp.sfu.layer', rid: 'f' })
    await offered(a.guest)
    const offer = a.guest.frames().find(frame => frame.t === 'pp.sfu.offer')
    expect(offer).toEqual({
      t: 'pp.sfu.offer', sdp: 'offer:S2', fresh: true, iceServers: [{ urls: ['turn:t'], username: 'u', credential: 'c' }],
      tracks: [{ mid: '0', trackName: 'video', kind: 'video' }, { mid: '1', trackName: 'audio', kind: 'audio' }],
    })
    await say(a.guest, { t: 'pp.sfu.answer', sdp: 'guest-answer' })
    await portal.settled()
    expect(sfu.calls.slice(2)).toEqual(['new', 'S2 pull S1/video:h,S1/audio', 'S2 renegotiate guest-answer', 'S2 update 0:f'])
    expect(a.guest.frames().at(-1)).toEqual({ t: 'pp.sfu.layer', rid: 'f', ok: true })
    expect(sfu.overlaps).toBe(0)

    // A second guest has a session of its own; the SFU's secret reaches nobody.
    const b = await join()
    await say(host, { t: 'pp.admit', g: b.g })
    await offered(b.guest)
    await say(b.guest, { t: 'pp.sfu.answer', sdp: 'b-answer' })
    await portal.settled()
    expect(sfu.calls.slice(-2)).toEqual(['S3 pull S1/video:h,S1/audio', 'S3 renegotiate b-answer'])
    for (const ws of [host, a.guest, b.guest]) expect(JSON.stringify(ws.sent)).not.toContain('TOKEN')
    expect((await portal.sfuSessions()).map(session => [session.id, session.role])).toEqual([['S1', 'host'], ['S2', 'guest'], ['S3', 'guest']])

    // A guest that leaves has its session closed.
    await portal.webSocketClose(b.guest as never)
    await portal.settled()
    expect(sfu.calls.at(-1)).toBe('S3 close 0,1')
  })

  it('subscribes a guest admitted before the host published once the picture is there, retrying until it reaches the SFU', async () => {
    const { portal, say, host, join, sfu } = await v2room()
    const a = await join()
    await say(host, { t: 'pp.admit', g: a.g })
    await portal.settled()
    expect(sfu.calls).toEqual([])
    sfu.failPulls = 1
    await say(host, publish)
    await offered(a.guest)
    await say(a.guest, { t: 'pp.sfu.answer', sdp: 'late-answer' })
    await portal.settled()
    expect(sfu.calls).toEqual(['new', 'S1 publish video@0,audio@1', 'new', 'S2 pull S1/video:h,S1/audio', 'new', 'S3 pull S1/video:h,S1/audio', 'S3 renegotiate late-answer'])
    expect(a.guest.frames().filter(frame => frame.t === 'pp.sfu.offer')).toHaveLength(1)
  })

  it('tells a guest when the SFU will not take it, and the host which guest that was', async () => {
    const { portal, say, host, join, sfu } = await v2room()
    await say(host, publish)
    await portal.settled()
    const a = await join()
    sfu.failPulls = 10
    await say(host, { t: 'pp.admit', g: a.g })
    await portal.settled()
    expect(a.guest.frames().at(-1)).toEqual({ t: 'pp.sfu.error', why: 'not_found_track_error' })
    expect(host.frames().at(-1)).toEqual({ t: 'pp.sfu.error', g: a.g, why: 'not_found_track_error' })
    await say(host, { ...publish, tracks: [{ mid: '0', trackName: 'screen', kind: 'video' }] })
    expect(host.frames().at(-1)).toEqual({ t: 'pp.sfu.error', why: 'bad_publish' })
  })

  it('keeps the guests waiting when the host leaves; the next host checks and admits them again', async () => {
    const { portal, connect, say, host, join, sfu } = await v2room()
    await say(host, publish)
    await portal.settled()
    const a = await join()
    await say(host, { t: 'pp.admit', g: a.g })
    await offered(a.guest)
    await say(a.guest, { t: 'pp.sfu.answer', sdp: 'x' })
    await portal.settled()
    host.close(1006, 'gone')
    await portal.webSocketClose(host as never)
    await portal.settled()
    expect(a.guest.closed).toBeNull()
    expect(a.guest.frames().at(-1)).toEqual({ t: 'pp.wait' })
    expect(sfu.calls.at(-1)).toBe('S2 close 0,1')

    const next = connect('host')
    await say(next, hostV2)
    expect(next.frames()).toEqual([{ t: 'pp.ready', v: 2, sfu: true }, { t: 'pp.guest', open: true, g: a.g }, { t: 'pp.from', g: a.g, f: guestHello }])
    await say(next, publish)
    await portal.settled()
    // Published again, but this guest is not subscribed until the new host admits it.
    expect(sfu.calls.at(-1)).toBe('S3 publish video@0,audio@1')
  })

  it('makes its SFU client again after hibernation', async () => {
    const { portal, say, host, sfu } = await v2room()
    ;(portal as unknown as { sfuApi: unknown }).sfuApi = null
    await say(host, publish)
    await portal.settled()
    expect(sfu.calls).toEqual(['new', 'S1 publish video@0,audio@1'])
    expect(host.frames().at(-1)).toMatchObject({ t: 'pp.sfu.answer', sdp: 'answer:S1' })
  })

  it('gives a v1 host only the newest of the guests a v2 host left waiting', async () => {
    const { portal, connect, say, host, join } = await v2room()
    const a = await join()
    const b = await join()
    host.close(1006, 'gone')
    await portal.webSocketClose(host as never)
    sfuApp.mockResolvedValue(null)
    const old = connect('host')
    await say(old, hostHello)
    expect(a.guest.closed?.code).toBe(PORTAL_CLOSE.replaced)
    expect(b.guest.closed).toBeNull()
    expect(old.frames()).toEqual([{ t: 'pp.ready' }, { t: 'pp.guest', open: true }, guestHello])
  })
})

describe('the guest page', () => {
  it('serves the copy in server/assets', () => {
    expect(PORTAL_GUEST_HTML).toBe(readFileSync(new URL('../../server/assets/portal-guest.html', import.meta.url), 'utf8'))
  })
})
