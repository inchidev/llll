import type { LiveState, PublicUser } from '../../shared/types'
import type { L4Env } from '../../workers/env'
import { LIVE_FAILURE_STATUS, type LiveEndResult, type LiveFailure, type LiveJoinResult } from '../../workers/live-room'
import { asRpc, fail } from './cf'

type LiveRoom = {
  getLive: () => Promise<LiveState>
  joinLive: (user: PublicUser, opts?: { meetingId?: string }) => Promise<LiveJoinResult>
  leaveLive: (userId: string) => Promise<LiveState>
  declineLive: (userId: string) => Promise<LiveState>
  endLive: (userId: string) => Promise<LiveEndResult>
  closeLive: () => Promise<LiveState>
  removeLiveParticipant: (hostId: string, userId: string) => Promise<LiveEndResult>
  pingLive: (userId: string) => Promise<boolean>
  revalidateLive: () => Promise<void>
}

/** The Live room of one conversation. Its Channel Durable Object owns the room. */
export function liveRoom(env: L4Env, channelId: string) {
  return asRpc<LiveRoom>(env.CHANNEL_DO.getByName(`channel:${channelId}`))
}

export function failLive(result: LiveFailure): never {
  fail(LIVE_FAILURE_STATUS[result.code], result.code, result.message)
}

/**
 * After access changes, remove anyone who can no longer open a conversation
 * from its Live room. Without ids, checks every room that is live.
 */
export async function revalidateLiveRooms(env: L4Env, channelIds?: string[]): Promise<void> {
  const ids = channelIds ?? await liveChannelIds(env)
  await Promise.allSettled(ids.map(id => liveRoom(env, id).revalidateLive()))
}

/**
 * End every live room before the server's RealtimeKit connection is removed
 * or moved to another app, while their meetings can still be reached.
 */
export async function closeLiveRooms(env: L4Env): Promise<void> {
  await Promise.allSettled((await liveChannelIds(env)).map(id => liveRoom(env, id).closeLive()))
}

async function liveChannelIds(env: L4Env): Promise<string[]> {
  return ((await env.DB.prepare('SELECT id FROM channels WHERE live_meeting_id IS NOT NULL')
    .all<{ id: string }>()).results ?? []).map(row => row.id)
}
