import type { LiveKind } from './types'

/**
 * Product copy for a conversation's Live room. A 1:1 Direct Message presents it
 * as a Call; every other conversation as Live. Internal values such as `kind`
 * never become labels on their own.
 */
export function liveKindFor(pairDm: boolean): LiveKind {
  return pairDm ? 'call' : 'live'
}

export function liveStartLabel(kind: LiveKind): string {
  return kind === 'call' ? 'Call' : 'Start live'
}

export function liveJoinLabel(kind: LiveKind): string {
  return kind === 'call' ? 'Join call' : 'Join live'
}

export function liveInProgressLabel(kind: LiveKind): string {
  return kind === 'call' ? 'Call in progress' : 'Live now'
}

export function liveTitle(kind: LiveKind): string {
  return kind === 'call' ? 'Call' : 'Live'
}

export function liveNotificationTitle(kind: LiveKind, actorName: string, channelName: string | null): string {
  if (kind === 'call') return `${actorName} is calling`
  return channelName ? `${actorName} is live in #${channelName}` : `${actorName} started a live session`
}

export function liveEndedTitle(kind: LiveKind): string {
  return kind === 'call' ? 'Call ended' : 'Live session ended'
}
