import { chatAttention } from './chat-attention'
import { chatAlertRecipients } from './chat-alerts'
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
           AND u.id IN (SELECT user_id FROM space_members WHERE space_id = (SELECT space_id FROM channels WHERE id = ?))
         ORDER BY u.id`,
      ).bind(root.id, authorId, root.id).all<{ id: string }>()
    : await db.prepare(
        `SELECT id
         FROM users
         WHERE status = 'active' AND id <> ? AND id IN (SELECT user_id FROM space_members WHERE space_id = (SELECT space_id FROM channels WHERE id = ?))
         ORDER BY id`,
      ).bind(authorId, root.id).all<{ id: string }>()
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
  const mentions = await env.DB.prepare('SELECT user_id AS id FROM message_mentions WHERE message_id = ?').bind(message.id).all<{ id: string }>()
  const mentioned = mentions.results.map(row => row.id)
  const alerts = new Set(await chatAlertRecipients(env, { rootId: audience.rootChannelId, channelId: message.channelId,
    actorId: message.author.id, dm: audience.rootType === 'dm', mentioned, candidates: audience.recipientIds }))
  await Promise.all([
    stub.notifyChannelActivity({ ...event, notify: true }, audience.recipientIds.filter(id => alerts.has(id))),
    stub.notifyChannelActivity({ ...event, notify: false }, audience.recipientIds.filter(id => !alerts.has(id))),
  ])
}

export async function signalChannelRead(
  env: L4Env,
  userId: string,
  channelId: string,
  messageId: string,
): Promise<void> {
  const root = await resolveChannelRoot(env.DB, channelId)
  if (!root) return
  const state = await env.DB.prepare(`SELECT r.last_read_message_id AS cursor, COALESCE(a.read_generation, 0) AS generation
    FROM channels c LEFT JOIN channel_reads r ON r.channel_id = c.id AND r.user_id = ?2
    LEFT JOIN channel_attention a ON a.channel_id = c.id AND a.user_id = ?2 WHERE c.id = ?1`)
    .bind(channelId, userId).first<{ cursor: string | null; generation: number }>()
  const event: ServerChannelReadEvent = {
    t: 'channel.read',
    generation: state?.generation ?? 0,
    sourceChannelId: channelId,
    rootChannelId: root.id,
    messageId: state ? state.cursor ?? '' : messageId,
    unread: await channelHasUnread(env.DB, userId, root.id),
  }
  const stub = asRpc<{
    notifyChannelRead: (event: ServerChannelReadEvent, userId: string) => Promise<void>
  }>(env.SERVER_DO.getByName(`server:${(await getServerId(env.DB))}`))
  await stub.notifyChannelRead(event, userId)
}

export async function signalChatAttention(env: L4Env, userId: string, channelId: string): Promise<void> {
  const stub = asRpc<{
    notifyChatAttention: (event: import('../shared/server-realtime').ServerChatAttentionEvent, userId: string) => Promise<void>
  }>(env.SERVER_DO.getByName(`server:${await getServerId(env.DB)}`))
  const state = await chatAttention(env.DB, channelId, userId)
  await stub.notifyChatAttention({ t: 'chat.attention', channelId, readGeneration: state.readGeneration }, userId)
}
