import { and, desc, eq, like, lt } from 'drizzle-orm'
import { z } from 'zod'
import { messages, users } from '../../drizzle/schema'
import { extractMentionIds } from '../../shared/mentions'
import { newId, nowIso } from '../../shared/ids'
import { hasPermission, Permission } from '../../shared/permissions'
import type { AuthorizationContext } from '../../shared/authorization'
import { authorizeMcpCredential } from '../../shared/authorization'
import type { L4Env } from '../../workers/env'
import { asRpc, fail } from './cf'
import { getDb } from './db'
import { auditStatement, hydrateMessages, toPublicUser } from './messages'
import { requireChannelAccessForMember, requireMemberForUser } from './channel-access'
import type { ServerMembership as Membership } from './channel-access'
import { messageNotificationStatement, signalNotificationOutbox } from '../../workers/notifications'
import { signalChannelActivity, signalChannelRead } from '../../workers/channel-activity'
import { signalAgentsForMessage } from '../../workers/agent-ingress'
import { channelLastMessageTimes, channelUnreadCounts } from '../../workers/unread'
import { removeMessageData } from '../../shared/file-cleanup'

export type RateRule = { key: string; limit: number; windowMs: number }

/** One budget for every send path: HTTP, MCP, scheduled reminders and the chat socket. */
export const messageSendRate = (userId: string): RateRule => ({ key: `user:${userId}:msg`, limit: 30, windowMs: 10_000 })
export const reactionRate = (userId: string): RateRule => ({ key: `user:${userId}:reaction`, limit: 30, windowMs: 10_000 })
export const uploadRate = (userId: string): RateRule => ({ key: `user:${userId}:upload`, limit: 40, windowMs: 10 * 60_000 })
export const UPLOAD_BYTES_PER_HOUR = 250 * 1024 * 1024

/** Only a runtime without the binding (plain `nuxt dev`) skips limits; a limiter error propagates. */
export async function takeRate(env: L4Env, rule: RateRule): Promise<boolean> {
  if (!env.RATE_LIMIT_DO) return true
  return asRpc<{ take: (limit: number, windowMs: number) => Promise<boolean> }>(env.RATE_LIMIT_DO.getByName(rule.key)).take(rule.limit, rule.windowMs)
}

/** Fails closed: a limiter outage refuses the write rather than lifting the limit, like the chat socket. */
export async function requireRate(env: L4Env, rule: RateRule, message: string) {
  let allowed: boolean
  try { allowed = await takeRate(env, rule) }
  catch { fail(503, 'rate_limit_unavailable', 'Rate limiting is temporarily unavailable. Try again in a moment.') }
  if (!allowed) fail(429, 'rate_limited', message)
}

/** Authors may always remove their own message; Manage channels moderates server channels, never DMs or mailboxes. */
export function messageDeleteRole(authorId: string, actorId: string, access: { perms: number; mailbox: boolean }): 'author' | 'moderator' | null {
  if (authorId === actorId) return 'author'
  return !access.mailbox && hasPermission(access.perms, Permission.manageChannels) ? 'moderator' : null
}

/** Shared by HTTP and the chat socket; the caller fans out and retries file cleanup. Returns whether a pin was removed. */
export async function removeChannelMessage(env: L4Env, input: { id: string; channelId: string; authorId: string; actorId: string; serverId: string; moderator: boolean; authorization?: AuthorizationContext }) {
  const pin = await env.DB.prepare('SELECT message_id FROM message_pins WHERE message_id = ?').bind(input.id).first()
  await removeMessageData(env, input.id, nowIso())
  if (input.moderator) {
    await (await auditStatement(env, { serverId: input.serverId, actorId: input.actorId, action: 'message.delete', targetType: 'message',
      targetId: input.id, meta: { channelId: input.channelId, authorId: input.authorId }, authorization: input.authorization })).run()
  }
  return Boolean(pin)
}

export async function deleteChannelMessage(env: L4Env, actor: Membership, id: string) {
  const row = await env.DB.prepare('SELECT channel_id as channelId, author_id as authorId, deleted_at as deletedAt FROM messages WHERE id = ?')
    .bind(id).first<{ channelId: string; authorId: string; deletedAt: string | null }>()
  if (!row) fail(404, 'not_found', 'Message not found')
  // Read access is enough, so a frozen DM or a denied Send messages still lets authors remove their words.
  const access = await requireChannelAccessForMember(env, actor, row.channelId)
  const role = messageDeleteRole(row.authorId, access.user.id, { perms: access.perms, mailbox: access.mailPermission !== null })
  if (!role) fail(403, 'forbidden', 'Not your message')
  if (row.deletedAt) return { ok: true }
  const pinned = await removeChannelMessage(env, { id, channelId: row.channelId, authorId: row.authorId, actorId: access.user.id,
    serverId: access.serverId, moderator: role === 'moderator', authorization: access.authorization })
  try {
    const stub = asRpc<{ fanout: (msg: unknown) => Promise<void> }>(env.CHANNEL_DO.getByName(`channel:${row.channelId}`))
    await stub.fanout({ t: 'message.delete', id })
    if (pinned) await stub.fanout({ t: 'pin', messageId: id, pin: null })
  }
  catch { /* local without DO */ }
  return { ok: true }
}

export const sendMessageSchema = z.object({
  content: z.string().max(2000),
  replyToId: z.string().min(8).optional(),
  clientId: z.string().min(1).max(80).optional(),
  attachmentIds: z.array(z.string().min(8)).max(8).optional(),
  agentMode: z.enum(['queue', 'steer']).optional(),
})

export async function requireMessageMember(env: L4Env, authorization: AuthorizationContext, scope: 'messages:read' | 'messages:write') {
  const user = (await getDb(env.DB).select().from(users).where(eq(users.id, authorization.principal.id)).limit(1))[0]
  if (!user) fail(403, 'forbidden', 'Not a member of this server')
  const member = await requireMemberForUser(env, toPublicUser(user), authorization.serverId, undefined, authorization)
  authorizeMcpCredential(member.authorization, scope)
  return member
}

export async function listMessageChannels(env: L4Env, member: Membership, input: { limit?: number; cursor?: string; name?: string } = {}) {
  authorizeMcpCredential(member.authorization, 'messages:read')
  const limit = Math.max(1, Math.min(input.limit ?? 25, 50))
  const canManageAgents = member.isOwner || hasPermission(member.perms, Permission.useAgents)
  // Match chat navigation visibility before pagination. The shared channel
  // guard remains authoritative for every returned item (including threads).
  const rows = await env.DB.prepare(
    `SELECT c.id FROM channels c JOIN channels root ON root.id =
       CASE WHEN c.type = 'thread' AND c.parent_id IS NOT NULL THEN c.parent_id ELSE c.id END
     WHERE (root.visibility = 'server' OR EXISTS
       (SELECT 1 FROM channel_members cm WHERE cm.channel_id = root.id AND cm.user_id = ?))
     AND NOT EXISTS (SELECT 1 FROM email_mailboxes m WHERE m.channel_id = root.id)
     AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.discussion_channel_id = root.id)
     AND (? = 1 OR root.type <> 'dm' OR NOT EXISTS
       (SELECT 1 FROM channel_members cm JOIN users u ON u.id = cm.user_id WHERE cm.channel_id = root.id AND u.kind = 'agent'))
     AND (? IS NULL OR c.id < ?) AND (? IS NULL OR c.name LIKE ?)
     ORDER BY c.id DESC LIMIT ?`,
  ).bind(member.user.id, canManageAgents ? 1 : 0, input.cursor ?? null, input.cursor ?? null,
    input.name ?? null, `%${input.name ?? ''}%`, limit + 1).all<{ id: string }>()
  const page = (rows.results ?? []).slice(0, limit)
  const channels = await Promise.all(page.map(async ({ id }) => {
    try {
      const access = await requireChannelAccessForMember(env, member, id)
      const channel = access.channel
      return { id, name: channel.name, topic: channel.topic, type: channel.type, parentId: channel.parentId,
        parentMessageId: channel.parentMessageId, participants: access.participants, frozen: access.frozen,
        canSend: !access.frozen && hasPermission(access.perms, Permission.sendMessages) }
    }
    catch (error) {
      // Access can disappear between the bounded listing and the final guard.
      if (error instanceof Error && 'statusCode' in error && error.statusCode === 404) return null
      throw error
    }
  }))
  const visible = channels.filter(channel => channel !== null)
  // The same counts as the Inbox: threads count only once the member has opened them.
  const [unread, lastMessages] = await Promise.all([
    channelUnreadCounts(env.DB, member.user.id, visible.map(channel => channel.id)),
    channelLastMessageTimes(env.DB, visible.map(channel => channel.id)),
  ])
  return {
    channels: visible.map(channel => ({ ...channel, unread: (unread.get(channel.id) ?? 0) > 0, unreadCount: unread.get(channel.id) ?? 0, lastMessageAt: lastMessages.get(channel.id) ?? null })),
    nextCursor: (rows.results?.length ?? 0) > limit ? page.at(-1)?.id ?? null : null,
  }
}

export async function listMessageMembers(env: L4Env, member: Membership, input: { limit?: number; cursor?: string; name?: string; kind?: 'human' | 'agent' } = {}) {
  authorizeMcpCredential(member.authorization, 'messages:read')
  const limit = Math.max(1, Math.min(input.limit ?? 25, 50))
  const canViewAgents = member.isOwner || hasPermission(member.perms, Permission.useAgents)
  const rows = await getDb(env.DB).select().from(users).where(and(
    eq(users.status, 'active'), input.cursor ? lt(users.id, input.cursor) : undefined,
    !canViewAgents ? eq(users.kind, 'human') : undefined,
    input.kind ? eq(users.kind, input.kind) : undefined,
    input.name ? like(users.displayName, `%${input.name}%`) : undefined,
  )).orderBy(desc(users.id)).limit(limit + 1)
  const page = rows.slice(0, limit)
  return { members: page.map(user => ({ ...toPublicUser(user), nickname: user.nickname, mentionToken: `<@${user.id}>` })),
    nextCursor: rows.length > limit ? page.at(-1)?.id ?? null : null }
}

export async function readChannelMessages(env: L4Env, member: Membership, channelId: string, input: { limit?: number; cursor?: string | null } = {}) {
  authorizeMcpCredential(member.authorization, 'messages:read')
  const access = await requireChannelAccessForMember(env, member, channelId)
  const limit = Math.max(1, Math.min(Math.floor(input.limit || 50), 50))
  const db = getDb(env.DB)
  const filters = input.cursor ? and(eq(messages.channelId, channelId), lt(messages.id, input.cursor)) : eq(messages.channelId, channelId)
  const rows = await db.select().from(messages).where(filters).orderBy(desc(messages.id)).limit(limit + 1)
  const hasMore = rows.length > limit
  const page = hasMore ? rows.slice(0, limit) : rows
  const dtos = await hydrateMessages(env, [...page].reverse(), member.user.id)
  const thread = access.channel
  const rootRows = thread.type === 'thread' && thread.parentId && thread.parentMessageId
    ? await db.select().from(messages).where(and(eq(messages.id, thread.parentMessageId), eq(messages.channelId, thread.parentId))).limit(1)
    : []
  const [rootMessage] = await hydrateMessages(env, rootRows, member.user.id)
  const read = await env.DB.prepare('SELECT last_read_message_id as lastReadMessageId FROM channel_reads WHERE channel_id = ? AND user_id = ?')
    .bind(channelId, member.user.id).first<{ lastReadMessageId: string | null }>()
  return { frozen: access.frozen, messages: dtos, rootMessage: rootMessage ?? null, nextCursor: hasMore ? page.at(-1)?.id ?? null : null, lastReadMessageId: read?.lastReadMessageId ?? null }
}

export async function sendChannelMessage(env: L4Env, actor: Membership, channelId: string, input: z.input<typeof sendMessageSchema>, schedule: (promise: Promise<unknown>) => void, deliveryId?: string, notifyAgents = true) {
  authorizeMcpCredential(actor.authorization, 'messages:write')
  const member = await requireChannelAccessForMember(env, actor, channelId, Permission.sendMessages, 'POST')
  const body = sendMessageSchema.parse(input)
  if (deliveryId) {
    const previous = await env.DB.prepare('SELECT id FROM messages WHERE id=? AND channel_id=? AND author_id=?')
      .bind(deliveryId, channelId, actor.user.id).first()
    if (previous) {
      const row = (await getDb(env.DB).select().from(messages).where(eq(messages.id, deliveryId)).limit(1))[0]!
      const [message] = await hydrateMessages(env, [row], actor.user.id)
      return { message }
    }
  }
  if (!body.content.trim() && !body.attachmentIds?.length) fail(400, 'bad_request', 'Empty message')
  if (body.attachmentIds?.length && !hasPermission(member.perms, Permission.attachFiles)) {
    fail(403, 'forbidden', 'Missing permission')
  }
  await requireRate(env, messageSendRate(actor.user.id), 'Too many messages. Slow down.')

  if (body.replyToId) {
    const reply = await env.DB.prepare(
      'SELECT id FROM messages WHERE id = ? AND channel_id = ?',
    ).bind(body.replyToId, channelId).first()
    if (!reply) fail(400, 'bad_request', 'Invalid reply target')
  }

  const requestedAttachments = [...new Set(body.attachmentIds ?? [])]
  const attachmentRows = [] as Array<{ id: string }>
  if (requestedAttachments.length) {
    const placeholders = requestedAttachments.map(() => '?').join(',')
    const rows = await env.DB.prepare(
      `SELECT id FROM attachments
       WHERE id IN (${placeholders}) AND message_id IS NULL AND channel_id = ? AND uploader_id = ?`,
    ).bind(...requestedAttachments, channelId, member.user.id).all<{ id: string }>()
    attachmentRows.push(...(rows.results ?? []))
    if (attachmentRows.length !== requestedAttachments.length) fail(400, 'bad_request', 'Invalid attachment')
  }

  const requestedMentions = extractMentionIds(body.content)
  let mentionIds: string[] = []
  if (requestedMentions.length) {
    const placeholders = requestedMentions.map(() => '?').join(',')
    const rows = await env.DB.prepare(
      `SELECT id FROM users WHERE id IN (${placeholders}) AND status = 'active'`,
    ).bind(...requestedMentions).all<{ id: string }>()
    mentionIds = (rows.results ?? []).map((row) => row.id)
  }

  const id = deliveryId ?? newId()
  const created = nowIso()
  const notification = await messageNotificationStatement(env, {
    id,
    channelId,
    author: member.user,
    content: body.content,
    mentions: mentionIds,
    attachmentCount: attachmentRows.length,
  })
  const audit = actor.authorization.credential.kind === 'mcp'
    ? await auditStatement(env, { serverId: member.serverId, actorId: member.user.id, action: 'message.create',
        targetType: 'message', targetId: id, meta: { channelId, mentions: mentionIds }, authorization: actor.authorization })
    : null
  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO messages (id, channel_id, author_id, content, reply_to_id, edited_at, deleted_at, created_at) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?)',
    ).bind(id, channelId, member.user.id, body.content, body.replyToId ?? null, created),
    ...attachmentRows.map((attachment) => env.DB.prepare(
      'UPDATE attachments SET message_id = ? WHERE id = ? AND message_id IS NULL',
    ).bind(id, attachment.id)),
    ...mentionIds.map((userId) => env.DB.prepare(
      'INSERT OR IGNORE INTO message_mentions (message_id, user_id) VALUES (?, ?)',
    ).bind(id, userId)),
    env.DB.prepare(
      `INSERT INTO channel_reads (channel_id, user_id, last_read_message_id, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(channel_id, user_id) DO UPDATE
       SET last_read_message_id = excluded.last_read_message_id, updated_at = excluded.updated_at
       WHERE channel_reads.last_read_message_id IS NULL
          OR channel_reads.last_read_message_id < excluded.last_read_message_id`,
    ).bind(channelId, member.user.id, id, created),
    ...(notification ? [notification] : []),
    ...(audit ? [audit] : []),
  ])
  schedule(signalNotificationOutbox(env))
  schedule(signalChannelActivity(env, {
    id,
    channelId,
    author: member.user,
    content: body.content,
    attachmentCount: attachmentRows.length,
  }))
  schedule(signalChannelRead(env, member.user.id, channelId, id))
  const db = getDb(env.DB)
  const row = (await db.select().from(messages).where(eq(messages.id, id)).limit(1))[0]!
  const [dto] = await hydrateMessages(env, [row], member.user.id)
  try {
    const stub = asRpc<{ fanout: (msg: unknown) => Promise<void> }>(env.CHANNEL_DO.getByName(`channel:${channelId}`))
    await stub.fanout({ t: 'message', message: dto })
  }
  catch { /* local without DO */ }
  if (notifyAgents) schedule(signalAgentsForMessage(env, {
    messageId: id,
    channelId,
    authorId: member.user.id,
    authorName: member.user.displayName,
    content: body.content,
    mentionIds,
    mode: body.agentMode,
  }))
  return { message: dto }
}
