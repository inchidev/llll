import { eq } from 'drizzle-orm'
import { channelCategories, channelMembers, channels } from '../../../../drizzle/schema'
import { channelUnreadCounts, recentThreads } from '../../../../workers/unread'
import { requireMember } from '../../../utils/guards'
import { cf } from '../../../utils/cf'
import { getDb } from '../../../utils/db'
import type { LiveState, SidebarThreadDTO } from '../../../../shared/types'
import { liveRoom } from '../../../utils/live'

/** Threads stay in the navigation while active; older ones remain one tap away in the channel's Threads panel. */
const THREAD_ACTIVE_DAYS = 7
const THREADS_PER_CHANNEL = 5

export default defineEventHandler(async (event) => {
  const workspaceId = getRouterParam(event, 'id')!
  const member = await requireMember(event, workspaceId)
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
    .filter((ch) => !hiddenIds.has(ch.id) && ch.type !== 'dm' && ch.type !== 'thread' && (ch.visibility === 'workspace' || privateIds.has(ch.id)))
  const since = new Date(Date.now() - THREAD_ACTIVE_DAYS * 24 * 60 * 60 * 1000).toISOString()
  const [unread, threadRows] = await Promise.all([
    channelUnreadCounts(env.DB, member.user.id, list.map(channel => channel.id)),
    recentThreads(env.DB, member.user.id, since),
  ])
  const visibleIds = new Set(list.map(channel => channel.id))
  const threadsByParent = new Map<string, SidebarThreadDTO[]>()
  for (const row of threadRows) {
    if (!visibleIds.has(row.parentId)) continue
    const group = threadsByParent.get(row.parentId) ?? []
    group.push({ ...row, unread: row.unreadCount > 0 })
    threadsByParent.set(row.parentId, group)
  }
  const threads = [...threadsByParent.values()].flatMap(group => group
    .sort((a, b) => Number(b.unread) - Number(a.unread) || b.lastMessageAt.localeCompare(a.lastMessageAt))
    .slice(0, THREADS_PER_CHANNEL))
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
        workspaceId,
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
      }
    }),
    threads,
  }
})
