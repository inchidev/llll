import { and, eq } from 'drizzle-orm'
import { channels, channelMembers } from '../../../../../drizzle/schema'
import { requireChannelAccess } from '../../../../utils/guards'
import { cf, fail } from '../../../../utils/cf'
import { getDb } from '../../../../utils/db'
import { fanoutDm, loadParticipants } from '../../../../utils/dms'
import { revalidateLiveRooms } from '../../../../utils/live'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const userId = getRouterParam(event, 'userId')!
  const access = await requireChannelAccess(event, id)
  if (access.channel.type !== 'dm') fail(404, 'not_found', 'Channel not found')
  if (userId !== access.user.id && (access.channel.dmKind !== 'group' || access.channel.dmOwnerId !== access.user.id)) {
    fail(403, 'forbidden', 'Only the group creator can remove other participants')
  }
  const { env, waitUntil } = cf(event)
  const db = getDb(env.DB)
  await db.delete(channelMembers).where(and(eq(channelMembers.channelId, id), eq(channelMembers.userId, userId)))
  if (userId === access.channel.dmOwnerId) {
    await db.update(channels).set({ dmOwnerId: null }).where(and(eq(channels.id, id), eq(channels.dmOwnerId, userId)))
  }
  const remaining = await loadParticipants(env, id)
  await fanoutDm(env, id, { t: 'dm.participants', participants: remaining })
  // Whoever left or was removed leaves the Live room too.
  waitUntil(revalidateLiveRooms(env, [id]))
  return { ok: true }
})
