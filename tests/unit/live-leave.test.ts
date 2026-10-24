import { afterEach, expect, it, vi } from 'vitest'
import { ChannelDurableObject } from '../../workers/channel-do'
const mocks = vi.hoisted(() => ({ remove: vi.fn(async () => {}), signal: vi.fn(async () => {}) }))
vi.mock('cloudflare:workers', () => ({ DurableObject: class { constructor(protected ctx: unknown, protected env: unknown) {} } }))
vi.mock('../../workers/live-media', () => ({ liveMedia: async () => ({ removeParticipants: mocks.remove }) }))
vi.mock('../../workers/live-events', () => ({ signalLiveChanged: mocks.signal }))
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks() })
function room(participants: string[]) {
  vi.stubGlobal('WebSocketRequestResponsePair', class { request = 'ping' })
  const data = new Map<string, unknown>([
    ['live', { active: true, meetingId: 'private-meeting', participantIds: participants, kind: 'live', startedBy: 'member', startedAt: '2026-10-24', ringing: false }],
    ['liveSeats', participants.length ? { member: { participantId: 'seat' } } : {}], ['livePresence', { member: Date.now() }], ['liveCleanupAt', 1234],
  ])
  const pending: Promise<unknown>[] = []
  const put = vi.fn(async (key: string | Record<string, unknown>, value?: unknown) => {
    if (typeof key === 'string') data.set(key, structuredClone(value))
    else for (const [k, v] of Object.entries(key)) data.set(k, structuredClone(v))
  })
  const storage = { get: async (key: string) => structuredClone(data.get(key)), put, delete: async (key: string) => data.delete(key), setAlarm: vi.fn(), deleteAlarm: vi.fn() }
  const ctx = { storage, id: { name: 'channel:private' }, setWebSocketAutoResponse: vi.fn(), getWebSockets: () => [], waitUntil: (p: Promise<unknown>) => pending.push(p) }
  const env = { DB: { prepare: () => ({ bind: () => ({ first: async () => ({ type: 'text' }), run: async () => ({ success: true }), all: async () => ({ results: [] }) }) }) } }
  return { instance: new ChannelDurableObject(ctx as never, env as never), data, put, pending, storage }
}
it.each([[[]], [['member']]])('makes a non-participant leave a read-only no-op for %j', async participants => {
  const r = room(participants)
  const before = structuredClone([...r.data])
  await r.instance.leaveLive('outsider')
  expect([...r.data]).toEqual(before)
  expect(r.put).not.toHaveBeenCalled(); expect(r.storage.setAlarm).not.toHaveBeenCalled(); expect(r.storage.deleteAlarm).not.toHaveBeenCalled()
  expect(mocks.remove).not.toHaveBeenCalled(); expect(mocks.signal).not.toHaveBeenCalled()
})
it('still removes a seated participant without asking for their revoked channel access', async () => {
  const r = room(['member'])
  const result = await r.instance.leaveLive('member')
  await Promise.all(r.pending)
  expect(result.participantIds).toEqual([])
  expect(r.data.get('liveSeats')).toEqual({})
  expect(mocks.remove).toHaveBeenCalledWith('private-meeting', ['seat'])
})
