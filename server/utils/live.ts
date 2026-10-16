import type { LiveState, PublicUser } from '../../shared/types'
import type { L4Env } from '../../workers/env'
import { LIVE_FAILURE_STATUS, type LiveEndResult, type LiveFailure, type LiveJoinResult } from '../../workers/live-room'
import { asRpc, fail } from './cf'

type LiveRoom = {
  getLive: () => Promise<LiveState>
  joinLive: (user: PublicUser) => Promise<LiveJoinResult>
  leaveLive: (userId: string) => Promise<LiveState>
  declineLive: (userId: string) => Promise<LiveState>
  endLive: (userId: string) => Promise<LiveEndResult>
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
  const ids = channelIds ?? ((await env.DB.prepare('SELECT id FROM channels WHERE huddle_meeting_id IS NOT NULL')
    .all<{ id: string }>()).results ?? []).map(row => row.id)
  await Promise.allSettled(ids.map(id => liveRoom(env, id).revalidateLive()))
}
