import { and, eq } from 'drizzle-orm'
import type { H3Event } from 'h3'
import { channelMembers, channels, tasks, users } from '../../drizzle/schema'
import type { PrivateChannelMemberDTO } from '../../shared/types'
import type { ServerChannelAccessChangedEvent, ServerChannelsChangedEvent } from '../../shared/server-realtime'
import type { L4Env } from '../../workers/env'
import { asRpc, cf, fail } from './cf'
import { getDb } from './db'
import { requireChannelAccess } from './guards'
import { toPublicUser } from './messages'

/** Management never grants admission: managers must already belong to the channel. */
export async function requirePrivateChannelManager(event: H3Event, id: string) {
  const access = await requireChannelAccess(event, id)
  if (access.channel.createdBy !== access.user.id) fail(403, 'forbidden', 'Only the channel creator can manage its members')
  if (access.channel.type !== 'text' || access.channel.visibility !== 'private' || access.mailPermission) {
    fail(400, 'invalid_channel', 'Manage members here only for private server channels')
  }
  const discussion = await getDb(cf(event).env.DB).select({ id: tasks.id }).from(tasks).where(eq(tasks.discussionChannelId, id)).limit(1)
  if (discussion[0]) fail(400, 'invalid_channel', 'Task discussion access follows its board')
  return access
}

export async function privateChannelMembers(env: L4Env, id: string): Promise<PrivateChannelMemberDTO[]> {
  const rows = await getDb(env.DB).select({ user: users }).from(channelMembers)
    .innerJoin(users, eq(users.id, channelMembers.userId))
    .where(eq(channelMembers.channelId, id))
  return rows.map(({ user }) => ({ user: toPublicUser(user), status: user.status }))
    .sort((a, b) => a.user.displayName.localeCompare(b.user.displayName))
}

/** Close held channel/Thread sockets and revoke media seats before acknowledging removal. */
export async function refreshPrivateChannelAccess(env: L4Env, serverId: string, id: string, removedUserId?: string) {
  const db = getDb(env.DB)
  const threads = await db.select({ id: channels.id }).from(channels).where(eq(channels.parentId, id))
  const conversationIds = [id, ...threads.map(thread => thread.id)]
  if (removedUserId) {
    await env.DB.prepare(`UPDATE notification_outbox SET failed_at=?,last_error='access_revoked',lease_token=NULL,lease_until=NULL
      WHERE recipient_id=? AND delivered_at IS NULL AND failed_at IS NULL
      AND (channel_id=? OR channel_id IN(SELECT id FROM channels WHERE parent_id=?))`)
      .bind(new Date().toISOString(), removedUserId, id, id).run()
  }
  const members = await db.select({ id: users.id }).from(channelMembers)
    .innerJoin(users, eq(users.id, channelMembers.userId))
    .where(and(eq(channelMembers.channelId, id), eq(users.status, 'active')))
  const stub = asRpc<{ notifyChannelAccessChanged: (event: ServerChannelAccessChangedEvent, recipientIds: string[]) => Promise<void> }>(env.SERVER_DO.getByName(`server:${serverId}`))
  const event = { t: 'channel.access.changed', serverId, channelId: id, conversationIds, revoked: false } as const
  try {
    await Promise.all(conversationIds.map(channelId => asRpc<{ revalidateAccess: () => Promise<void> }>(env.CHANNEL_DO.getByName(`channel:${channelId}`)).revalidateAccess()))
  } catch {
    fail(503, 'access_refresh_pending', 'Membership changed, but active connections could not all be refreshed. Retry to finish cleanup.')
  } finally {
    // Reflect committed D1 access even when a media provider is unavailable.
    await stub.notifyChannelAccessChanged(event, members.map(member => member.id))
    if (removedUserId) await stub.notifyChannelAccessChanged({ ...event, revoked: true }, [removedUserId])
  }
}

/**
 * After a visibility change, admission differs for everyone who is not a member. Held sockets
 * are rechecked; members keep the channel, everyone else is told it is gone (private) or that
 * the channel list changed (server).
 */
export async function refreshChannelVisibility(env: L4Env, serverId: string, id: string, visibility: 'server' | 'private') {
  const db = getDb(env.DB)
  const threads = await db.select({ id: channels.id }).from(channels).where(eq(channels.parentId, id))
  const conversationIds = [id, ...threads.map(thread => thread.id)]
  const stub = asRpc<{
    notifyChannelAccessChanged: (event: ServerChannelAccessChangedEvent, recipientIds: string[]) => Promise<void>
    notifyChannelsChanged: (event: ServerChannelsChangedEvent, recipientIds?: string[]) => Promise<void>
  }>(env.SERVER_DO.getByName(`server:${serverId}`))
  let memberIds: string[] = []
  let otherIds: string[] = []
  if (visibility === 'private') {
    await env.DB.prepare(`UPDATE notification_outbox SET failed_at=?,last_error='access_revoked',lease_token=NULL,lease_until=NULL
      WHERE delivered_at IS NULL AND failed_at IS NULL AND (channel_id=? OR channel_id IN(SELECT id FROM channels WHERE parent_id=?))
      AND recipient_id NOT IN (SELECT user_id FROM channel_members WHERE channel_id=?)`)
      .bind(new Date().toISOString(), id, id, id).run()
    const rows = await env.DB.prepare(`SELECT u.id, EXISTS(SELECT 1 FROM channel_members cm WHERE cm.channel_id=? AND cm.user_id=u.id) AS member
      FROM users u WHERE u.status='active'`).bind(id).all<{ id: string, member: number }>()
    memberIds = (rows.results ?? []).filter(row => row.member).map(row => row.id)
    otherIds = (rows.results ?? []).filter(row => !row.member).map(row => row.id)
  }
  const event = { t: 'channel.access.changed', serverId, channelId: id, conversationIds, revoked: false } as const
  try {
    await Promise.all(conversationIds.map(channelId => asRpc<{ revalidateAccess: () => Promise<void> }>(env.CHANNEL_DO.getByName(`channel:${channelId}`)).revalidateAccess()))
  } catch {
    fail(503, 'access_refresh_pending', 'Visibility changed, but active connections could not all be refreshed. Retry to finish cleanup.')
  } finally {
    if (visibility === 'private') {
      await stub.notifyChannelAccessChanged(event, memberIds)
      if (otherIds.length) await stub.notifyChannelAccessChanged({ ...event, revoked: true }, otherIds)
    }
    else {
      await stub.notifyChannelsChanged({ t: 'channels.changed', serverId, deletedIds: [], parentIds: [] })
    }
  }
}
