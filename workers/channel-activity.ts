import { getServerId } from '../shared/server-id'
import { notificationPreview } from '../shared/notifications'
import { channelPath } from '../shared/paths'
import type { PublicUser } from '../shared/types'
import type { ServerChannelActivityEvent, ServerChannelReadEvent } from '../shared/server-realtime'
import { asRpc, type L4Env } from './env'
import { channelHasUnread } from './unread'

type ChannelRoot = {
  id: string
  name: string
  type: string
  visibility: string
}

export type ChannelActivityAudience = {
  sourceChannelId: string
  rootChannelId: string
  rootName: string
  rootType: string
  recipientIds: string[]
}

export async function resolveChannelRoot(db: D1Database, channelId: string): Promise<ChannelRoot | null> {
  const source = await db.prepare(
    'SELECT id, name, type, visibility, parent_id FROM channels WHERE id = ?',
  ).bind(channelId).first<ChannelRoot & { parent_id: string | null }>()
  if (!source) return null
  if (source.type !== 'thread') return source
  if (!source.parent_id) return null
  return db.prepare(
    'SELECT id, name, type, visibility FROM channels WHERE id = ?',
  ).bind(source.parent_id).first<ChannelRoot>()
}

export async function channelActivityAudience(
  db: D1Database,
  channelId: string,
  authorId: string,
): Promise<ChannelActivityAudience | null> {
  const root = await resolveChannelRoot(db, channelId)
  if (!root) return null
  const restricted = root.visibility === 'private' || root.type === 'dm'
  const rows = restricted
    ? await db.prepare(
        `SELECT u.id
         FROM channel_members cm
         JOIN users u ON u.id = cm.user_id
         WHERE cm.channel_id = ? AND u.status = 'active' AND u.id <> ?
         ORDER BY u.id`,
      ).bind(root.id, authorId).all<{ id: string }>()
    : await db.prepare(
        `SELECT id
         FROM users
         WHERE status = 'active' AND id <> ?
         ORDER BY id`,
      ).bind(authorId).all<{ id: string }>()
  return {
    sourceChannelId: channelId,
    rootChannelId: root.id,
    rootName: root.name,
    rootType: root.type,
    recipientIds: (rows.results ?? []).map(row => row.id),
  }
}

export async function signalChannelActivity(
  env: L4Env,
  message: {
    id: string
    channelId: string
    author: PublicUser
    content: string
    attachmentCount: number
  },
  alsoNotify: string[] = [],
): Promise<void> {
  const audience = await channelActivityAudience(env.DB, message.channelId, message.author.id)
  if (!audience) return
  audience.recipientIds = [...new Set([...audience.recipientIds, ...alsoNotify])]
  if (audience.rootType === 'dm') {
    await env.DB.prepare('UPDATE channel_members SET hidden_at = NULL WHERE channel_id = ?').bind(audience.rootChannelId).run()
  }
  if (!audience.recipientIds.length) return
  const event: ServerChannelActivityEvent = {
    t: 'channel.activity',
    sourceChannelId: audience.sourceChannelId,
    rootChannelId: audience.rootChannelId,
    messageId: message.id,
    notification: {
      title: audience.rootType === 'dm'
        ? message.author.displayName
        : `${message.author.displayName} in #${audience.rootName}`,
      body: notificationPreview(message.content, message.attachmentCount),
      url: audience.sourceChannelId === audience.rootChannelId
        ? channelPath(audience.rootChannelId)
        : channelPath(audience.rootChannelId, audience.sourceChannelId),
    },
  }
  const stub = asRpc<{
    notifyChannelActivity: (event: ServerChannelActivityEvent, recipientIds: string[]) => Promise<void>
  }>(env.SERVER_DO.getByName(`server:${(await getServerId(env.DB))}`))
  await stub.notifyChannelActivity(event, audience.recipientIds)
}

export async function signalChannelRead(
  env: L4Env,
  userId: string,
  channelId: string,
  messageId: string,
): Promise<void> {
  const root = await resolveChannelRoot(env.DB, channelId)
  if (!root) return
  const event: ServerChannelReadEvent = {
    t: 'channel.read',
    sourceChannelId: channelId,
    rootChannelId: root.id,
    messageId,
    unread: await channelHasUnread(env.DB, userId, root.id),
  }
  const stub = asRpc<{
    notifyChannelRead: (event: ServerChannelReadEvent, userId: string) => Promise<void>
  }>(env.SERVER_DO.getByName(`server:${(await getServerId(env.DB))}`))
  await stub.notifyChannelRead(event, userId)
}
