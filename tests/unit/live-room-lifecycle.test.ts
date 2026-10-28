import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChannelDurableObject } from '../../workers/channel-do'
import { LIVE_END_RETRY_LIMIT, LIVE_PRESENCE_TTL_MS, LIVE_RING_TIMEOUT_MS, liveGraceMs } from '../../workers/live-room'
import type { LiveState, PublicUser } from '../../shared/types'
import { ALL_PERMISSIONS, MemberPermissions, Permission } from '../../shared/permissions'

const mocks = vi.hoisted(() => ({
  media: null as null | Record<string, ReturnType<typeof vi.fn>>,
  signal: vi.fn(async () => {}),
}))
vi.mock('cloudflare:workers', () => ({ DurableObject: class { constructor(protected ctx: unknown, protected env: unknown) {} } }))
vi.mock('../../workers/live-media', () => ({ liveMedia: async () => mocks.media }))
vi.mock('../../workers/live-events', () => ({ signalLiveChanged: mocks.signal }))
vi.mock('../../workers/notifications', () => ({
  liveNotificationStatement: async () => null,
  messageNotificationStatement: async () => null,
  signalNotificationOutbox: async () => {},
}))
vi.mock('../../workers/env', async original => ({
  ...await original<typeof import('../../workers/env')>(),
  callsProvider: () => 'realtimekit',
}))

type Authz = { serverId: string, perms: number, ownerId: string, type: string, frozen: boolean, canManageAgents: boolean, mailbox: boolean, archived: boolean }

let now = Date.parse('2026-10-28T10:00:00.000Z')

function user(id: string): PublicUser {
  return { id, kind: 'human', displayName: id, avatarR2Key: null } as PublicUser
}

function fakeMedia() {
  let meetings = 0
  let seats = 0
  return {
    createMeeting: vi.fn(async () => {
      // Yield so two concurrent starts would interleave without the room's queue.
      await new Promise(resolve => setTimeout(resolve, 1))
      return { id: `meeting-${++meetings}` }
    }),
    addParticipant: vi.fn(async (_meetingId: string, seat: { customId: string }) => {
      const id = `seat-${seat.customId}-${++seats}`
      return { id, token: `token-${id}` }
    }),
    removeParticipants: vi.fn(async () => {}),
    endMeeting: vi.fn(async () => {}),
  }
}

function room(opts: { directMessage?: boolean, members?: number, access?: Record<string, Partial<Authz> | null> } = {}) {
  vi.stubGlobal('WebSocketRequestResponsePair', class { request = 'ping' })
  const data = new Map<string, unknown>()
  const pending: Promise<unknown>[] = []
  let alarmAt: number | null = null
  const storage = {
    get: async (key: string) => structuredClone(data.get(key)),
    put: async (key: string | Record<string, unknown>, value?: unknown) => {
      if (typeof key === 'string') data.set(key, structuredClone(value))
      else for (const [k, v] of Object.entries(key)) data.set(k, structuredClone(v))
    },
    delete: async (key: string | string[]) => {
      for (const k of Array.isArray(key) ? key : [key]) data.delete(k)
    },
    setAlarm: async (at: number) => { alarmAt = at },
    deleteAlarm: async () => { alarmAt = null },
  }
  const ctx = {
    storage,
    id: { name: 'channel:room' },
    setWebSocketAutoResponse: vi.fn(),
    getWebSockets: () => [],
    waitUntil: (promise: Promise<unknown>) => { pending.push(promise) },
  }
  const sql: string[] = []
  const statement = (text: string) => {
    const stmt = {
      bind: () => stmt,
      first: async () => (text.startsWith('SELECT id FROM channels') ? { id: 'room' } : null),
      run: async () => { sql.push(text); return { success: true } },
      all: async () => ({ results: [] }),
    }
    return stmt
  }
  const limiter = { take: vi.fn(async () => true), giveBack: vi.fn(async () => {}) }
  const env = {
    DB: {
      prepare: statement,
      batch: async (statements: unknown[]) => statements.map(() => ({ success: true })),
    },
    RATE_LIMIT_DO: { getByName: () => limiter },
  }
  const instance = new ChannelDurableObject(ctx as never, env as never)
  const directMessage = opts.directMessage ?? false
  const access = opts.access ?? {}
  Object.assign(instance, {
    loadAuthz: async (userId: string): Promise<Authz | null> => {
      if (userId in access && access[userId] === null) return null
      return {
        serverId: 'server',
        perms: directMessage ? ALL_PERMISSIONS & ~Permission.manageChannels : MemberPermissions,
        ownerId: 'owner',
        type: directMessage ? 'dm' : 'text',
        frozen: false,
        canManageAgents: false,
        mailbox: false,
        archived: false,
        ...access[userId],
      }
    },
    isDirectMessage: async () => directMessage,
    directMessageSize: async () => opts.members ?? (directMessage ? 2 : 5),
  })
  return {
    instance,
    data,
    limiter,
    pending,
    sql,
    alarmAt: () => alarmAt,
    live: () => data.get('live') as LiveState | undefined,
    async alarm() {
      await instance.alarm()
      await Promise.all(pending)
    },
  }
}

beforeEach(() => {
  now = Date.parse('2026-10-28T10:00:00.000Z')
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  mocks.media = fakeMedia()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  mocks.signal.mockClear()
})

function media() {
  return mocks.media as unknown as ReturnType<typeof fakeMedia>
}

function outcomes() {
  return (mocks.signal.mock.calls as unknown as Array<[unknown, string, LiveState, { outcome?: string }]>)
    .map(call => call[3]?.outcome).filter(Boolean)
}

describe('Channel room start and join', () => {
  it('shares one meeting between two people starting at once', async () => {
    const r = room()
    const [a, b] = await Promise.all([r.instance.joinLive(user('alice')), r.instance.joinLive(user('bob'))])
    expect(media().createMeeting).toHaveBeenCalledTimes(1)
    expect(a.ok && b.ok).toBe(true)
    if (!a.ok || !b.ok) return
    expect(a.meetingId).toBe('meeting-1')
    expect(b.meetingId).toBe('meeting-1')
    expect(r.live()).toMatchObject({ active: true, startedBy: 'alice', participantIds: ['alice', 'bob'], kind: 'live' })
    expect(r.limiter.take).toHaveBeenCalledTimes(1)
  })

  it('makes only the starter and Channel managers hosts', async () => {
    const r = room({ access: { manager: { perms: MemberPermissions | Permission.manageChannels } } })
    await r.instance.joinLive(user('alice'))
    await r.instance.joinLive(user('bob'))
    await r.instance.joinLive(user('manager'))
    expect(media().addParticipant.mock.calls.map(call => [call[1].customId, call[1].host])).toEqual([
      ['alice', true], ['bob', false], ['manager', true],
    ])
  })

  it('does not spend a start from the rate limit when RealtimeKit refuses it', async () => {
    const r = room()
    media().createMeeting.mockRejectedValueOnce(new Error('RealtimeKit HTTP 500'))
    const result = await r.instance.joinLive(user('alice'))
    await Promise.all(r.pending)
    expect(result).toMatchObject({ ok: false, code: 'realtimekit_failed' })
    expect(r.limiter.giveBack).toHaveBeenCalledTimes(1)
    expect(r.live()).toBeUndefined()
  })

  it('refuses to start without the grant but lets anyone with access join', async () => {
    const r = room({ access: { guest: { perms: Permission.sendMessages } } })
    expect(await r.instance.joinLive(user('guest'))).toMatchObject({ ok: false, code: 'forbidden' })
    await r.instance.joinLive(user('alice'))
    expect(await r.instance.joinLive(user('guest'))).toMatchObject({ ok: true })
  })

  it('replaces the older seat when someone joins again from another tab', async () => {
    const r = room()
    await r.instance.joinLive(user('alice'))
    await r.instance.joinLive(user('alice'))
    await Promise.all(r.pending)
    expect(media().removeParticipants).toHaveBeenCalledWith('meeting-1', ['seat-alice-1'])
    expect(r.data.get('liveSeats')).toEqual({ alice: { participantId: 'seat-alice-2' } })
    expect(r.live()?.participantIds).toEqual(['alice'])
    // The older tab still finds a seat, so it can tell a replacement from a removal.
    expect(await r.instance.pingLive('alice')).toBe(true)
  })
})

describe('Reconnecting', () => {
  it('rejoins the same meeting with a fresh seat', async () => {
    const r = room()
    await r.instance.joinLive(user('alice'))
    const again = await r.instance.joinLive(user('alice'), { meetingId: 'meeting-1' })
    expect(again).toMatchObject({ ok: true, meetingId: 'meeting-1' })
    expect(media().createMeeting).toHaveBeenCalledTimes(1)
  })

  it('never starts a new room for a reconnect after the room ended', async () => {
    const r = room()
    await r.instance.joinLive(user('alice'))
    await r.instance.endLive('alice')
    expect(await r.instance.joinLive(user('alice'), { meetingId: 'meeting-1' })).toMatchObject({ ok: false, code: 'not_found' })
    await r.instance.joinLive(user('bob'))
    expect(await r.instance.joinLive(user('alice'), { meetingId: 'meeting-1' })).toMatchObject({ ok: false, code: 'not_found' })
    expect(media().createMeeting).toHaveBeenCalledTimes(2)
  })
})

describe('Calls', () => {
  it('ends a Call for both people when either hangs up', async () => {
    const r = room({ directMessage: true })
    await r.instance.joinLive(user('alice'))
    expect(r.live()).toMatchObject({ kind: 'call', ringing: true })
    await r.instance.joinLive(user('bob'))
    expect(r.live()).toMatchObject({ ringing: false, participantIds: ['alice', 'bob'] })
    const ended = await r.instance.leaveLive('bob')
    expect(ended.active).toBe(false)
    expect(media().endMeeting).toHaveBeenCalledWith('meeting-1')
    expect(r.data.has('liveSeats')).toBe(false)
  })

  it('stops ringing as unanswered after the ring timeout', async () => {
    const r = room({ directMessage: true })
    await r.instance.joinLive(user('alice'))
    now += LIVE_RING_TIMEOUT_MS - 1
    await r.alarm()
    expect(r.live()?.active).toBe(true)
    now += 1
    await r.alarm()
    expect(r.live()?.active).toBe(false)
    expect(media().endMeeting).toHaveBeenCalledWith('meeting-1')
    expect(outcomes()).toEqual(['unanswered'])
  })

  it('lets the callee decline, but not the caller', async () => {
    const r = room({ directMessage: true })
    await r.instance.joinLive(user('alice'))
    expect((await r.instance.declineLive('alice')).active).toBe(true)
    expect((await r.instance.declineLive('bob')).active).toBe(false)
    expect(outcomes()).toEqual(['declined'])
  })

  it('does not let a host remove the other person from a Call', async () => {
    const r = room({ directMessage: true })
    await r.instance.joinLive(user('alice'))
    await r.instance.joinLive(user('bob'))
    expect(await r.instance.removeLiveParticipant('alice', 'bob')).toMatchObject({ ok: false, code: 'forbidden' })
  })
})

describe('Presence and cleanup', () => {
  it('closes an empty Channel room after its grace period', async () => {
    const r = room()
    await r.instance.joinLive(user('alice'))
    await r.instance.leaveLive('alice')
    expect(r.live()).toMatchObject({ active: true, participantIds: [] })
    expect(r.alarmAt()).toBe(now + liveGraceMs('live', false))
    now += liveGraceMs('live', false) - 1
    await r.alarm()
    expect(r.live()?.active).toBe(true)
    now += 1
    await r.alarm()
    expect(r.live()?.active).toBe(false)
    expect(r.sql).toContain('UPDATE channels SET live_meeting_id = NULL WHERE id = ?')
  })

  it('expires a silent participant and re-adds them on their next heartbeat', async () => {
    const r = room()
    await r.instance.joinLive(user('alice'))
    now += LIVE_PRESENCE_TTL_MS + 1
    await r.alarm()
    expect(r.live()).toMatchObject({ active: true, participantIds: [] })
    expect(r.data.has('liveCleanupAt')).toBe(true)
    expect(await r.instance.pingLive('alice')).toBe(true)
    expect(r.live()?.participantIds).toEqual(['alice'])
    expect(r.data.has('liveCleanupAt')).toBe(false)
  })

  it('reports a heartbeat from someone without a seat as not joined', async () => {
    const r = room()
    await r.instance.joinLive(user('alice'))
    expect(await r.instance.pingLive('bob')).toBe(false)
  })

  it('makes leave by someone without a seat a no-op', async () => {
    const r = room()
    await r.instance.joinLive(user('alice'))
    const before = structuredClone([...r.data])
    await r.instance.leaveLive('outsider')
    expect([...r.data]).toEqual(before)
  })
})

describe('Access and host controls', () => {
  it('removes a Member who lost access when the room is revalidated', async () => {
    const access: Record<string, Partial<Authz> | null> = {}
    const r = room({ access })
    await r.instance.joinLive(user('alice'))
    await r.instance.joinLive(user('bob'))
    access.bob = null
    await r.instance.revalidateLive()
    expect(media().removeParticipants).toHaveBeenCalledWith('meeting-1', ['seat-bob-2'])
    expect(r.live()?.participantIds).toEqual(['alice'])
    expect(Object.keys(r.data.get('liveSeats') as object)).toEqual(['alice'])
  })

  it('lets a host remove a participant and refuses everyone else', async () => {
    const r = room()
    await r.instance.joinLive(user('alice'))
    await r.instance.joinLive(user('bob'))
    await r.instance.joinLive(user('carol'))
    expect(await r.instance.removeLiveParticipant('bob', 'carol')).toMatchObject({ ok: false, code: 'forbidden' })
    expect(await r.instance.removeLiveParticipant('alice', 'alice')).toMatchObject({ ok: false, code: 'forbidden' })
    const removed = await r.instance.removeLiveParticipant('alice', 'carol')
    expect(removed).toMatchObject({ ok: true })
    expect(media().removeParticipants).toHaveBeenCalledWith('meeting-1', ['seat-carol-3'])
    expect(r.live()?.participantIds).toEqual(['alice', 'bob'])
    expect(await r.instance.pingLive('carol')).toBe(false)
    expect(await r.instance.removeLiveParticipant('alice', 'carol')).toMatchObject({ ok: false, code: 'not_found' })
  })

  it('only lets hosts end the room for everyone', async () => {
    const r = room()
    await r.instance.joinLive(user('alice'))
    await r.instance.joinLive(user('bob'))
    expect(await r.instance.endLive('bob')).toMatchObject({ ok: false, code: 'forbidden' })
    expect(await r.instance.endLive('alice')).toMatchObject({ ok: true, live: { active: false } })
  })
})

describe('Ending when RealtimeKit fails', () => {
  it('ends the room locally when its meeting cannot be ended, then retries a bounded number of times', async () => {
    const r = room()
    await r.instance.joinLive(user('alice'))
    media().endMeeting.mockRejectedValue(new Error('RealtimeKit HTTP 500'))
    expect(await r.instance.endLive('alice')).toMatchObject({ ok: true, live: { active: false } })
    expect(r.data.has('liveSeats')).toBe(false)
    expect(r.data.get('liveEndRetries')).toEqual([{ meetingId: 'meeting-1', attempts: 1, at: now + 60_000 }])
    expect(r.alarmAt()).toBe(now + 60_000)

    for (let attempt = 1; attempt < LIVE_END_RETRY_LIMIT; attempt += 1) {
      now = r.alarmAt()!
      await r.alarm()
    }
    expect(media().endMeeting).toHaveBeenCalledTimes(LIVE_END_RETRY_LIMIT)
    expect(r.data.has('liveEndRetries')).toBe(false)
    expect(r.alarmAt()).toBeNull()
  })

  it('stops retrying once the meeting ends', async () => {
    const r = room()
    await r.instance.joinLive(user('alice'))
    media().endMeeting.mockRejectedValueOnce(new Error('RealtimeKit HTTP 500'))
    await r.instance.endLive('alice')
    now += 60_000
    await r.alarm()
    expect(media().endMeeting).toHaveBeenCalledTimes(2)
    expect(r.data.has('liveEndRetries')).toBe(false)
  })

  it('still closes an empty room whose meeting is gone', async () => {
    const r = room()
    await r.instance.joinLive(user('alice'))
    await r.instance.leaveLive('alice')
    media().endMeeting.mockRejectedValue(new Error('RealtimeKit HTTP 403'))
    now += liveGraceMs('live', false)
    await r.alarm()
    expect(r.live()?.active).toBe(false)
  })

  it('closes a room without a host when RealtimeKit is disconnected', async () => {
    const r = room()
    await r.instance.joinLive(user('alice'))
    expect((await r.instance.closeLive()).active).toBe(false)
    expect(media().endMeeting).toHaveBeenCalledWith('meeting-1')
  })
})
