import { and, eq, inArray, isNull } from 'drizzle-orm'
import { channels, channelMembers, users } from '../../../drizzle/schema'
import { WORKSPACE_ID } from '../../../shared/ids'
import { hasPermission, Permission } from '../../../shared/permissions'
import { channelUnreadCounts } from '../../../workers/unread'
import { requireMember } from '../../utils/guards'
import { cf } from '../../utils/cf'
import { getDb } from '../../utils/db'
import { toDmDto } from '../../utils/dms'

export default defineEventHandler(async (event) => {
  const member = await requireMember(event, WORKSPACE_ID)
  const me = member.user
  const { env } = cf(event)
  const db = getDb(env.DB)
  const mine = await db.select({
    channel: channels,
    hiddenAt: channelMembers.hiddenAt,
  }).from(channelMembers)
    .innerJoin(channels, eq(channels.id, channelMembers.channelId))
    .where(and(eq(channelMembers.userId, me.id), eq(channels.type, 'dm'), isNull(channelMembers.hiddenAt)))

  let visible = mine
  if (!member.isOwner && !hasPermission(member.perms, Permission.manageWorkspace) && mine.length) {
    const agentDms = await db.select({ channelId: channelMembers.channelId }).from(channelMembers)
      .innerJoin(users, eq(users.id, channelMembers.userId))
      .where(and(inArray(channelMembers.channelId, mine.map(row => row.channel.id)), eq(users.kind, 'agent')))
    const hiddenIds = new Set(agentDms.map(row => row.channelId))
    visible = mine.filter(row => !hiddenIds.has(row.channel.id))
  }

  const unread = await channelUnreadCounts(env.DB, me.id, visible.map(row => row.channel.id))
  const dtos = await Promise.all(visible.map(async (row) => {
    const unreadCount = unread.get(row.channel.id) ?? 0
    return {
      ...await toDmDto(env, row.channel, me.id, unreadCount > 0),
      unreadCount,
    }
  }))
  dtos.sort((a, b) => (b.lastMessageAt || b.createdAt).localeCompare(a.lastMessageAt || a.createdAt))
  return { channels: dtos }
})
