import { hasPermission, Permission } from '../shared/permissions'
import type { LiveKind, LiveState } from '../shared/types'

/** A joined participant is present while their client keeps sending heartbeats. Background tabs may slow them to one a minute. */
export const LIVE_PRESENCE_TTL_MS = 75_000
export { LIVE_RING_TIMEOUT_MS } from '../shared/live'
/** How many times an ended room retries ending its RealtimeKit meeting before giving up. */
export const LIVE_END_RETRY_LIMIT = 5

/** A RealtimeKit meeting whose room ended locally but whose remote end failed. */
export type LiveEndRetry = { meetingId: string, attempts: number, at: number }

/** Back off one more minute after each failed attempt to end a remote meeting. */
export function liveEndRetryDelayMs(attempts: number): number {
  return 60_000 * Math.max(1, attempts)
}

/**
 * How long an empty room stays open so people can come back. A Call that the
 * other person left explicitly ends at once; this covers dropped connections.
 */
export function liveGraceMs(kind: LiveKind, directMessage: boolean): number {
  if (kind === 'call') return 30_000
  return directMessage ? 60_000 : 5 * 60_000
}

export function emptyLive(): LiveState {
  return {
    active: false,
    meetingId: null,
    participantIds: [],
    startedBy: null,
    startedAt: null,
    kind: 'live',
    ringing: false,
  }
}

/** Read a stored room, including one saved before the Live rename. */
export function normalizeLive(stored: unknown): LiveState {
  if (!stored || typeof stored !== 'object') return emptyLive()
  const value = stored as Partial<LiveState> & { kind?: string }
  return {
    active: value.active === true && Boolean(value.meetingId),
    meetingId: value.meetingId ?? null,
    participantIds: Array.isArray(value.participantIds) ? value.participantIds : [],
    startedBy: value.startedBy ?? null,
    startedAt: value.startedAt ?? null,
    kind: value.kind === 'call' ? 'call' : 'live',
    ringing: value.ringing === true,
  }
}

/**
 * Hosts can remove, mute, and end for everyone. That is the person who started
 * the room, and in server Channels anyone who can manage the Channel. Both
 * people in a 1:1 Call are hosts.
 */
export function isLiveHost(live: LiveState, userId: string, access: { directMessage: boolean, perms: number }): boolean {
  if (live.kind === 'call' || live.startedBy === userId) return true
  if (access.directMessage) return false
  return hasPermission(access.perms, Permission.manageChannels)
}

export type LiveFailureCode =
  | 'not_found'
  | 'forbidden'
  | 'frozen'
  | 'rate_limited'
  | 'realtimekit_unconfigured'
  | 'realtimekit_failed'
  | 'calls_unavailable'

export type LiveFailure = { ok: false, code: LiveFailureCode, message: string }

export function liveFailure(code: LiveFailureCode, message: string): LiveFailure {
  return { ok: false, code, message }
}

export const LIVE_FAILURE_STATUS: Record<LiveFailureCode, number> = {
  not_found: 404,
  forbidden: 403,
  frozen: 403,
  rate_limited: 429,
  realtimekit_unconfigured: 501,
  realtimekit_failed: 502,
  calls_unavailable: 501,
}

export type LiveJoinResult = { ok: true, token: string, meetingId: string, live: LiveState } | LiveFailure
export type LiveEndResult = { ok: true, live: LiveState } | LiveFailure
