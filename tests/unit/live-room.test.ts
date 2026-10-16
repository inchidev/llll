import { describe, expect, it } from 'vitest'
import { directMessagePermissions, MemberPermissions, Permission } from '../../shared/permissions'
import { isLiveHost, liveGraceMs, normalizeLive } from '../../workers/live-room'
import type { LiveState } from '../../shared/types'

const room: LiveState = {
  active: true,
  meetingId: 'meeting',
  participantIds: ['starter'],
  startedBy: 'starter',
  startedAt: '2026-09-30T10:00:00.000Z',
  kind: 'live',
  ringing: false,
}

describe('Live room hosts', () => {
  it('makes the starter and Channel managers hosts in a workspace Channel', () => {
    const channel = { directMessage: false, perms: MemberPermissions }
    expect(isLiveHost(room, 'starter', channel)).toBe(true)
    expect(isLiveHost(room, 'member', channel)).toBe(false)
    expect(isLiveHost(room, 'manager', { directMessage: false, perms: Permission.manageChannels })).toBe(true)
  })

  it('makes only the starter a host in a group Direct Message', () => {
    expect(isLiveHost(room, 'member', { directMessage: true, perms: Permission.manageChannels })).toBe(false)
  })

  it('makes both people hosts in a 1:1 Call', () => {
    expect(isLiveHost({ ...room, kind: 'call' }, 'callee', { directMessage: true, perms: 0 })).toBe(true)
  })
})

describe('Live room lifecycle', () => {
  it('keeps an empty Channel room open longer than a Direct Message room', () => {
    expect(liveGraceMs('live', false)).toBeGreaterThan(liveGraceMs('live', true))
    expect(liveGraceMs('call', true)).toBeLessThanOrEqual(liveGraceMs('live', true))
  })

  it('reads a room stored before the Live rename', () => {
    expect(normalizeLive({
      active: true,
      huddleId: 'meeting',
      meetingId: 'meeting',
      participantIds: ['a'],
      startedBy: 'a',
      startedAt: '2026-09-01T00:00:00.000Z',
      kind: 'huddle',
      title: null,
    })).toEqual({
      active: true,
      meetingId: 'meeting',
      participantIds: ['a'],
      startedBy: 'a',
      startedAt: '2026-09-01T00:00:00.000Z',
      kind: 'live',
      ringing: false,
    })
    expect(normalizeLive(undefined).active).toBe(false)
  })
})

describe('Direct Message grants', () => {
  it('lets every participant talk but only roles with the grant start a call', () => {
    const withoutGrant = directMessagePermissions(Permission.sendMessages, false, false)
    expect(withoutGrant & Permission.sendMessages).toBeTruthy()
    expect(withoutGrant & Permission.startLive).toBe(0)
    expect(directMessagePermissions(Permission.startLive, false, false) & Permission.startLive).toBeTruthy()
    expect(directMessagePermissions(0, true, false) & Permission.startLive).toBeTruthy()
    expect(directMessagePermissions(MemberPermissions, false, true)).toBe(0)
  })
})
