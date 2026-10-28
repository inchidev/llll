import { getServerId } from '../../../shared/server-id'
import { and, eq, isNull } from 'drizzle-orm'
import { channels, channelMembers } from '../../../drizzle/schema'
import { hasPermission, Permission } from '../../../shared/permissions'
import { channelUnreadCounts, sidebarThreads } from '../../../workers/unread'
import { requireMember } from '../../utils/guards'
import { cf } from '../../utils/cf'
import { getDb } from '../../utils/db'
import { loadParticipantRows, toDmDtos } from '../../utils/dms'

export default defineEventHandler(async (event) => {
  const member = await requireMember(event, (await getServerId(cf(event).env.DB)))
  const me = member.user
  const { env } = cf(event)
  const db = getDb(env.DB)
  const mine = await db.select({ channel: channels }).from(channelMembers)
    .innerJoin(channels, eq(channels.id, channelMembers.channelId))
    .where(and(eq(channelMembers.userId, me.id), eq(channels.type, 'dm'), isNull(channelMembers.hiddenAt)))

  // Participants decide Agent visibility and hydrate every row, so load them once.
  const participants = await loadParticipantRows(env, mine.map(row => row.channel.id))
  const canSeeAgents = member.isOwner || hasPermission(member.perms, Permission.useAgents)
  const visible = mine.map(row => row.channel)
    .filter(channel => canSeeAgents || !participants.get(channel.id)?.some(user => user.kind === 'agent'))
  const ids = visible.map(channel => channel.id)

  const [unread, threads] = await Promise.all([
    channelUnreadCounts(env.DB, me.id, ids),
    sidebarThreads(env.DB, me.id, ids),
  ])
  const dtos = (await toDmDtos(env, visible, me.id, id => (unread.get(id) ?? 0) > 0, participants))
    .map(dto => ({ ...dto, unreadCount: unread.get(dto.id) ?? 0 }))
  dtos.sort((a, b) => (b.lastMessageAt || b.createdAt).localeCompare(a.lastMessageAt || a.createdAt))
  return { channels: dtos, threads }
})
