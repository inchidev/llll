import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PORTAL_CLOSE, PORTAL_PROTOCOL, portalLinks, portalLive, type PortalRecord } from '../../shared/portal'
import { sha256Hex } from '../../shared/server-settings'
import { PORTAL_GUEST_HTML } from '../../server/utils/portal-guest-page'

vi.mock('cloudflare:workers', () => ({ DurableObject: class { constructor(protected ctx: unknown, protected env: unknown) {} } }))
const mayKeep = vi.fn(async () => true)
vi.mock('../../server/utils/portals', () => ({ portalOpenerMayKeep: (...args: unknown[]) => mayKeep(...args as []) }))
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
      setAlarm: async () => {},
      deleteAlarm: async () => {},
    },
    acceptWebSocket: (ws: FakeSocket, tags: string[]) => { ws.tags.push(...tags); sockets.push(ws) },
    getWebSockets: (tag?: string) => sockets.filter(ws => !tag || ws.tags.includes(tag)),
    setWebSocketAutoResponse: () => {},
    waitUntil: () => {},
  }
  const portal = new PortalDurableObject(ctx as never, {} as never)
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

beforeEach(() => { mayKeep.mockReset(); mayKeep.mockResolvedValue(true) })

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

describe('the guest page', () => {
  it('serves the copy in server/assets', () => {
    expect(PORTAL_GUEST_HTML).toBe(readFileSync(new URL('../../server/assets/portal-guest.html', import.meta.url), 'utf8'))
  })
})
