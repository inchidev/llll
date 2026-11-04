import { computed, ref, shallowRef } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { LiveState } from '../../shared/types'

type Handler = (...args: unknown[]) => void

class Emitter {
  handlers = new Map<string, Set<Handler>>()
  on(event: string, handler: Handler) {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set())
    this.handlers.get(event)!.add(handler)
  }
  off(event: string, handler: Handler) { this.handlers.get(event)?.delete(handler) }
  emit(event: string, ...args: unknown[]) { for (const handler of this.handlers.get(event) ?? []) handler(...args) }
}

function fakeMeeting() {
  const self = Object.assign(new Emitter(), {
    id: 'self',
    disableAudio: vi.fn(async () => {}),
    enableAudio: vi.fn(async () => {}),
    disableVideo: vi.fn(async () => {}),
    enableVideo: vi.fn(async () => {}),
    enableScreenShare: vi.fn(async () => {}),
    disableScreenShare: vi.fn(async () => {}),
    getAllDevices: async () => [],
    setDevice: async () => {},
  })
  const joined = Object.assign(new Emitter(), { toArray: () => [] })
  return {
    join: vi.fn(async () => {}),
    leave: vi.fn(async () => {}),
    self,
    participants: Object.assign(new Emitter(), { joined }),
    audio: { setSpeakerDevice: vi.fn(), play: async () => {} },
  }
}

const sdk = vi.hoisted(() => ({ meetings: [] as unknown[], init: null as null | ReturnType<typeof vi.fn> }))
vi.mock('@cloudflare/realtimekit', () => ({ default: { init: (...args: unknown[]) => sdk.init!(...args) } }))

const live: LiveState = { active: true, meetingId: 'meeting-1', participantIds: ['me'], startedBy: 'me', startedAt: new Date().toISOString(), kind: 'live', ringing: false }

let fetchMock: ReturnType<typeof vi.fn>

function failure(statusCode: number) {
  return Object.assign(new Error(`HTTP ${statusCode}`), { statusCode, data: { error: { code: 'x', message: 'Refused' } } })
}

async function store() {
  const { useLiveStore } = await import('../../app/stores/live')
  return useLiveStore()
}

beforeEach(() => {
  vi.useFakeTimers()
  for (const [name, fn] of Object.entries({ ref, computed, shallowRef })) vi.stubGlobal(name, fn)
  vi.stubGlobal('navigateTo', vi.fn())
  fetchMock = vi.fn(async (url: string) => {
    if (url.endsWith('/live')) return { token: 'token', meetingId: 'meeting-1', live }
    if (url.endsWith('/heartbeat')) return { joined: true }
    return { ok: true }
  })
  vi.stubGlobal('$fetch', fetchMock)
  sdk.meetings = []
  sdk.init = vi.fn(async () => {
    const meeting = fakeMeeting()
    sdk.meetings.push(meeting)
    return meeting
  })
  setActivePinia(createPinia())
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function calls(suffix: string) {
  return fetchMock.mock.calls.filter(([url]) => String(url).endsWith(suffix))
}

describe('joining', () => {
  it('takes one seat when join is pressed twice while connecting', async () => {
    const s = await store()
    const options = { audio: true, video: false }
    await Promise.all([s.join('room', options), s.join('room', options)])
    expect(calls('/live')).toHaveLength(1)
    expect(sdk.init).toHaveBeenCalledTimes(1)
    expect(s.connection).toBe('connected')
  })

  it('shows the Server message when it refuses a join, and frees the seat when media fails', async () => {
    const s = await store()
    fetchMock.mockRejectedValueOnce(failure(403))
    await expect(s.join('room', { audio: true, video: false })).rejects.toThrow()
    expect(s.error).toBe('Refused')
    expect(s.errorTitle).toBe('Could not connect')

    sdk.init!.mockRejectedValueOnce(new Error('NotReadableError: Could not start video source'))
    await expect(s.join('room', { audio: true, video: false })).rejects.toThrow()
    expect(calls('/live/leave')).toHaveLength(1)
    expect(s.error).not.toContain('NotReadableError')
  })
})

describe('reconnecting', () => {
  it('restores a dropped connection to the same meeting and keeps mute and camera', async () => {
    const s = await store()
    await s.join('room', { audio: false, video: true })
    const first = sdk.meetings[0] as ReturnType<typeof fakeMeeting>
    first.self.emit('roomLeft', { state: 'disconnected' })
    expect(s.connection).toBe('reconnecting')
    expect(s.inRoom).toBe(true)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(s.connection).toBe('connected')
    const rejoin = calls('/live')[1]!
    expect(rejoin[1]).toMatchObject({ method: 'POST', body: { meetingId: 'meeting-1' } })
    expect(sdk.init).toHaveBeenLastCalledWith(expect.objectContaining({ defaults: { audio: false, video: true } }))
    expect(s.muted).toBe(true)
    expect(s.camera).toBe(true)
  })

  it('gives up after a bounded number of attempts with a clear message', async () => {
    const s = await store()
    await s.join('room', { audio: true, video: false })
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/live')) throw new Error('offline')
      return { ok: true }
    })
    ;(sdk.meetings[0] as ReturnType<typeof fakeMeeting>).self.emit('roomLeft', { state: 'failed' })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(calls('/live')).toHaveLength(1 + 4)
    expect(s.connection).toBe('error')
    expect(s.error).toMatch(/could not be restored/u)
    expect(calls('/live/leave')).toHaveLength(1)
  })

  it('stops reconnecting when the room ended or the person left', async () => {
    const s = await store()
    await s.join('room', { audio: true, video: false })
    ;(sdk.meetings[0] as ReturnType<typeof fakeMeeting>).self.emit('roomLeft', { state: 'disconnected' })
    await s.hangup()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(calls('/live')).toHaveLength(1)
    expect(s.connection).toBe('idle')

    await s.join('room', { audio: true, video: false })
    ;(sdk.meetings[1] as ReturnType<typeof fakeMeeting>).self.emit('roomLeft', { state: 'disconnected' })
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/live')) throw failure(404)
      return { ok: true }
    })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(s.connection).toBe('idle')
    expect(s.notice).toBe('Live session ended')
  })
})

describe('removal notices', () => {
  it('says the person joined elsewhere when their seat was replaced', async () => {
    const s = await store()
    await s.join('room', { audio: true, video: false })
    ;(sdk.meetings[0] as ReturnType<typeof fakeMeeting>).self.emit('roomLeft', { state: 'kicked' })
    await vi.advanceTimersByTimeAsync(0)
    expect(s.notice).toBe('You joined from another tab or device')
    expect(s.connection).toBe('idle')
  })

  it('says the person was removed when the room no longer has their seat', async () => {
    const s = await store()
    await s.join('room', { audio: true, video: false })
    fetchMock.mockImplementation(async (url: string) => (url.endsWith('/heartbeat') ? { joined: false } : { ok: true }))
    ;(sdk.meetings[0] as ReturnType<typeof fakeMeeting>).self.emit('roomLeft', { state: 'kicked' })
    await vi.advanceTimersByTimeAsync(0)
    expect(s.notice).toBe('You were removed from the live session')
  })
})

describe('incoming calls', () => {
  const ringing: LiveState = { ...live, kind: 'call', ringing: true }
  const event = { t: 'live.changed' as const, channelId: 'call', live: ringing, ring: true, notification: { title: 'Ana is calling', body: '', url: '/channels/call', tag: 't' } }

  it('rings until the timeout and stops when answered on another device', async () => {
    const s = await store()
    s.receiveLive(event as never)
    expect(s.incoming?.ringUntil).toBeLessThanOrEqual(Date.now() + 45_000)
    s.receiveLive({ ...event, live: { ...ringing, ringing: false }, ring: false, notification: undefined } as never)
    expect(s.incoming).toBeNull()
  })

  it('leaves the current room explicitly when answering', async () => {
    const s = await store()
    await s.join('room', { audio: true, video: false })
    s.receiveLive(event as never)
    await s.answerIncoming()
    expect(calls('/live/leave')).toHaveLength(1)
    expect(s.currentChannelId).toBeNull()
    expect(s.pendingJoin).toEqual({ channelId: 'call' })
  })

  it('ignores a call locally without declining it', async () => {
    const s = await store()
    s.receiveLive(event as never)
    s.ignoreIncoming()
    expect(s.incoming).toBeNull()
    expect(calls('/decline')).toHaveLength(0)
  })
})
