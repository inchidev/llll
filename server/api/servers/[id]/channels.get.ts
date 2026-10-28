import { and, notInArray, sql } from 'drizzle-orm'
import { channelCategories, channels } from '../../../../drizzle/schema'
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
  // DMs, threads and mailboxes have their own navigation; task discussions live inside their task.
  const list = await db.select().from(channels).where(and(
    notInArray(channels.type, ['dm', 'thread']),
    sql`(${channels.visibility} = 'server' OR EXISTS (SELECT 1 FROM channel_members cm WHERE cm.channel_id = ${channels.id} AND cm.user_id = ${member.user.id}))`,
    sql`NOT EXISTS (SELECT 1 FROM email_mailboxes mb WHERE mb.channel_id = ${channels.id})`,
    sql`NOT EXISTS (SELECT 1 FROM tasks t WHERE t.discussion_channel_id = ${channels.id})`,
  )).orderBy(channels.position)
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
