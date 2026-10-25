import { eq } from 'drizzle-orm'
import { channelCategories, channelMembers, channels } from '../../../../drizzle/schema'
import { channelLastMessageTimes, channelUnreadCounts, sidebarThreads } from '../../../../workers/unread'
import { requireMember } from '../../../utils/guards'
import { cf } from '../../../utils/cf'
import { getDb } from '../../../utils/db'
import type { LiveState } from '../../../../shared/types'
import { liveRoom } from '../../../utils/live'

export default defineEventHandler(async (event) => {
  const serverId = getRouterParam(event, 'id')!
  const member = await requireMember(event, serverId)
  const { env } = cf(event)
  const db = getDb(env.DB)
  const privateAccess = await db.select({ channelId: channelMembers.channelId }).from(channelMembers).where(eq(channelMembers.userId, member.user.id))
  const privateIds = new Set(privateAccess.map(row => row.channelId))
  const mailboxRows = await env.DB.prepare('SELECT channel_id as channelId FROM email_mailboxes').all<{ channelId: string }>()
  const mailboxIds = new Set((mailboxRows.results ?? []).map(row => row.channelId))
  // Task discussions live inside their task, not in the channel list.
  const discussionRows = await env.DB.prepare('SELECT discussion_channel_id as channelId FROM tasks WHERE discussion_channel_id IS NOT NULL').all<{ channelId: string }>()
  const hiddenIds = new Set([...mailboxIds, ...(discussionRows.results ?? []).map(row => row.channelId)])
  const list = (await db.select().from(channels).orderBy(channels.position))
    .filter((ch) => !hiddenIds.has(ch.id) && ch.type !== 'dm' && ch.type !== 'thread' && (ch.visibility === 'server' || privateIds.has(ch.id)))
  const [unread, threads, lastMessages] = await Promise.all([
    channelUnreadCounts(env.DB, member.user.id, list.map(channel => channel.id)),
    sidebarThreads(env.DB, member.user.id, list.map(channel => channel.id)),
    channelLastMessageTimes(env.DB, list.map(channel => channel.id)),
  ])
  const liveRooms = new Map<string, LiveState>()
  await Promise.all(list.filter(channel => channel.liveMeetingId).map(async (channel) => {
    const live = await liveRoom(env, channel.id).getLive()
    if (live.active) liveRooms.set(channel.id, live)
  }))

  return {
    categories: await db.select({
      id: channelCategories.id,
      name: channelCategories.name,
      position: channelCategories.position,
      createdAt: channelCategories.createdAt,
    }).from(channelCategories).orderBy(channelCategories.position),
    channels: list.map((ch) => {
      return {
        id: ch.id,
        createdBy: ch.createdBy,
        serverId,
        name: ch.name,
        topic: ch.topic,
        type: ch.type,
        visibility: ch.visibility,
        categoryId: ch.categoryId,
        position: ch.position,
        liveMeetingId: ch.liveMeetingId,
        parentId: ch.parentId,
        parentMessageId: ch.parentMessageId,
        unread: (unread.get(ch.id) ?? 0) > 0,
        unreadCount: unread.get(ch.id) ?? 0,
        live: liveRooms.get(ch.id) ?? null,
        createdAt: ch.createdAt,
        lastMessageAt: lastMessages.get(ch.id) ?? null,
      }
    }),
    threads,
  }
})
