import { and, desc, eq, like, lt } from 'drizzle-orm'
import { z } from 'zod'
import { messages, users } from '../../drizzle/schema'
import { extractMentionIds, roleDisplayName } from '../../shared/mentions'
import { newId, nowIso } from '../../shared/ids'
import { hasPermission, Permission } from '../../shared/permissions'
import { canViewAgentMembers } from '../../shared/project-access'
import type { AuthorizationContext } from '../../shared/authorization'
import { authorizeMcpCredential } from '../../shared/authorization'
import type { L4Env } from '../../workers/env'
import { asRpc, fail } from './cf'
import { getDb } from './db'
import { auditStatement, hydrateMessages, toPublicUser } from './messages'
import { requireChannelAccessForMember, requireMemberForUser } from './channel-access'
import type { ServerMembership as Membership } from './channel-access'
import { messageNotificationStatement, reminderNotificationStatement, signalNotificationOutbox } from '../../workers/notifications'
import { signalChannelActivity, signalChannelRead } from '../../workers/channel-activity'
import { signalAgentsForMessage } from '../../workers/agent-ingress'
import { persistMessageEdit } from '../../workers/message-edits'
import { roleMentionRecipients, roleMentionStatement } from '../../workers/role-mentions'
import { channelLastMessageTimes, channelUnreadCounts } from '../../workers/unread'
import { removeMessageData } from '../../shared/file-cleanup'
import { threadTitle } from '../../shared/threads'
import { openPairDm } from './dms'
import { canManageMessagePins, fanoutMessagePin, INSERT_MESSAGE_PIN_SQL, loadMessagePin } from './message-pins'
import { searchServerMessages, type ServerSearchInput } from './message-search'

export type RateRule = { key: string; limit: number; windowMs: number }

/** One budget for every send path: HTTP, MCP, scheduled reminders and the chat socket. */
export const messageSendRate = (userId: string): RateRule => ({ key: `user:${userId}:msg`, limit: 30, windowMs: 10_000 })
export const reactionRate = (userId: string): RateRule => ({ key: `user:${userId}:reaction`, limit: 30, windowMs: 10_000 })
export const uploadRate = (userId: string): RateRule => ({ key: `user:${userId}:upload`, limit: 40, windowMs: 10 * 60_000 })
export const UPLOAD_BYTES_PER_HOUR = 250 * 1024 * 1024

// One emoji: a keycap, a flag, or pictographs joined by ZWJ with optional variation selectors, skin tones and tags.
const EMOJI_PART = String.raw`\p{Extended_Pictographic}️?\p{Emoji_Modifier}?[\u{E0020}-\u{E007F}]*`
const EMOJI = new RegExp(String.raw`^(?:\p{Regional_Indicator}{2}|[#*0-9]️?⃣|${EMOJI_PART}(?:‍${EMOJI_PART})*)$`, 'u')
export const reactionEmojiSchema = z.string().min(1).max(16).regex(EMOJI, 'Not an emoji')

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
  // Moderation is always audited; so is every MCP write, like sends.
  if (input.moderator || input.authorization?.credential.kind === 'mcp') {
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
  const canViewAgents = canViewAgentMembers(member.authorization)
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

/** Roles the member may mention, with the token that mentions each. Agents are never reached through a Role. */
export async function listMentionRoles(env: L4Env, member: Membership) {
  authorizeMcpCredential(member.authorization, 'messages:read')
  const anyRole = member.isOwner || hasPermission(member.perms, Permission.manageChannels)
  const rows = await env.DB.prepare(`SELECT r.id, r.key, r.name, r.mentionable,
      (SELECT COUNT(*) FROM users u WHERE u.role_id = r.id AND u.status = 'active' AND u.kind = 'human') AS memberCount
    FROM roles r WHERE ? OR r.mentionable = 1 ORDER BY r.position, r.id`)
    .bind(anyRole ? 1 : 0).all<{ id: string; key: string; name: string; mentionable: number; memberCount: number }>()
  return { roles: (rows.results ?? []).map(role => ({ id: role.id, name: roleDisplayName(role), mentionable: Boolean(role.mentionable),
    memberCount: Number(role.memberCount), mentionToken: `<@&${role.id}>` })) }
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

export async function sendChannelMessage(env: L4Env, actor: Membership, channelId: string, input: z.input<typeof sendMessageSchema>, schedule: (promise: Promise<unknown>) => void, deliveryId?: string,
  { notifyAgents = true, remindUserId }: { notifyAgents?: boolean; remindUserId?: string } = {}) {
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
  const roleMentions = await roleMentionRecipients(env, { channelId, authorId: member.user.id, content: body.content, mentions: mentionIds })
  const roleRows = roleMentionStatement(env, id, roleMentions)
  const notification = await messageNotificationStatement(env, {
    id,
    channelId,
    author: member.user,
    content: body.content,
    mentions: mentionIds,
    roleMentions: roleMentions.map(mention => mention.userId),
    attachmentCount: attachmentRows.length,
  })
  // A scheduled reminder is authored by the person it reminds: keep it unread and notify them too.
  const remindSelf = remindUserId === member.user.id
  const reminder = remindUserId
    ? await reminderNotificationStatement(env, { id, channelId, author: member.user, content: body.content, mentions: mentionIds, attachmentCount: attachmentRows.length }, remindUserId)
    : null
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
    ...(roleRows ? [roleRows] : []),
    ...(remindSelf ? [] : [env.DB.prepare(
      `INSERT INTO channel_reads (channel_id, user_id, last_read_message_id, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(channel_id, user_id) DO UPDATE
       SET last_read_message_id = excluded.last_read_message_id, updated_at = excluded.updated_at
       WHERE channel_reads.last_read_message_id IS NULL
          OR channel_reads.last_read_message_id < excluded.last_read_message_id`,
    ).bind(channelId, member.user.id, id, created)]),
    ...(notification ? [notification] : []),
    ...(reminder ? [reminder] : []),
    ...(audit ? [audit] : []),
  ])
  schedule(signalNotificationOutbox(env))
  schedule(signalChannelActivity(env, {
    id,
    channelId,
    author: member.user,
    content: body.content,
    attachmentCount: attachmentRows.length,
  }, remindUserId ? [remindUserId] : []))
  if (!remindSelf) schedule(signalChannelRead(env, member.user.id, channelId, id))
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

export async function searchChannelMessages(env: L4Env, member: Membership, input: ServerSearchInput) {
  authorizeMcpCredential(member.authorization, 'messages:read')
  return searchServerMessages(env, member, input)
}

/** Threads of one accessible conversation, newest first. Read one with readChannelMessages. */
export async function listChannelThreads(env: L4Env, member: Membership, channelId: string, input: { limit?: number; cursor?: string } = {}) {
  authorizeMcpCredential(member.authorization, 'messages:read')
  const access = await requireChannelAccessForMember(env, member, channelId)
  if (access.channel.type === 'thread') fail(400, 'bad_request', 'Threads cannot hold threads')
  const limit = Math.max(1, Math.min(input.limit ?? 25, 50))
  const rows = await env.DB.prepare(
    `SELECT t.id, t.name, t.parent_message_id AS parentMessageId, t.created_at AS createdAt,
       root.author_id AS rootAuthorId, root.content AS rootContent, root.deleted_at AS rootDeletedAt,
       (SELECT COUNT(*) FROM messages m WHERE m.channel_id = t.id AND m.deleted_at IS NULL) AS replyCount,
       (SELECT m.created_at FROM messages m WHERE m.channel_id = t.id AND m.deleted_at IS NULL ORDER BY m.created_at DESC LIMIT 1) AS lastReplyAt
     FROM channels t LEFT JOIN messages root ON root.id = t.parent_message_id
     WHERE t.parent_id = ? AND t.type = 'thread' AND (? IS NULL OR t.id < ?)
     ORDER BY t.id DESC LIMIT ?`,
  ).bind(channelId, input.cursor ?? null, input.cursor ?? null, limit + 1).all<{
    id: string; name: string; parentMessageId: string | null; createdAt: string; rootAuthorId: string | null
    rootContent: string | null; rootDeletedAt: string | null; replyCount: number; lastReplyAt: string | null
  }>()
  const page = (rows.results ?? []).slice(0, limit)
  return {
    threads: page.map(row => ({
      id: row.id,
      title: row.name || threadTitle(row.rootDeletedAt ? '' : row.rootContent ?? ''),
      parentMessageId: row.parentMessageId,
      rootMessage: row.parentMessageId
        ? { id: row.parentMessageId, authorId: row.rootAuthorId, content: row.rootDeletedAt ? '' : (row.rootContent ?? '').slice(0, 180), deleted: Boolean(row.rootDeletedAt) }
        : null,
      replyCount: Number(row.replyCount),
      lastReplyAt: row.lastReplyAt,
      createdAt: row.createdAt,
    })),
    nextCursor: (rows.results?.length ?? 0) > limit ? page.at(-1)?.id ?? null : null,
  }
}

async function loadMessage(env: L4Env, messageId: string) {
  const row = (await getDb(env.DB).select().from(messages).where(eq(messages.id, messageId)).limit(1))[0]
  if (!row) fail(404, 'not_found', 'Message not found')
  return row
}

async function auditMcpWrite(env: L4Env, actor: Membership, action: string, targetType: string, targetId: string, meta: Record<string, unknown>) {
  if (actor.authorization.credential.kind !== 'mcp') return null
  return auditStatement(env, { serverId: actor.serverId, actorId: actor.user.id, action, targetType, targetId, meta, authorization: actor.authorization })
}

async function fanoutChannel(env: L4Env, channelId: string, event: unknown) {
  try {
    await asRpc<{ fanout: (msg: unknown) => Promise<void> }>(env.CHANNEL_DO.getByName(`channel:${channelId}`)).fanout(event)
  }
  catch { /* local without DO */ }
}

/** Same rules as PATCH /api/messages/:id: only the author, with send permission in that conversation. */
export async function editChannelMessage(env: L4Env, actor: Membership, messageId: string, input: { content: string }, schedule: (promise: Promise<unknown>) => void = () => {}) {
  authorizeMcpCredential(actor.authorization, 'messages:write')
  const content = z.string().min(1).max(2000).parse(input.content)
  if (!content.trim()) fail(400, 'bad_request', 'Empty message')
  const row = await loadMessage(env, messageId)
  if (row.deletedAt) fail(409, 'deleted', 'Message was deleted')
  const member = await requireChannelAccessForMember(env, actor, row.channelId, Permission.sendMessages, 'PATCH')
  if (row.authorId !== member.user.id) fail(403, 'forbidden', 'Not your message')
  const requestedMentions = extractMentionIds(content)
  const mentionIds = requestedMentions.length
    ? ((await env.DB.prepare(`SELECT id FROM users WHERE id IN (${requestedMentions.map(() => '?').join(',')}) AND status = 'active'`)
        .bind(...requestedMentions).all<{ id: string }>()).results ?? []).map(mention => mention.id)
    : []
  // The same edit path as the interface: only newly added mentions are notified and invoke Agents.
  const { added, notified } = await persistMessageEdit(env, { id: messageId, channelId: row.channelId, author: member.user, content, mentions: mentionIds, editedAt: nowIso() })
  const audit = await auditMcpWrite(env, actor, 'message.update', 'message', messageId, { channelId: row.channelId, mentions: mentionIds })
  if (audit) await audit.run()
  if (notified.length) schedule(signalNotificationOutbox(env))
  if (added.length) {
    schedule(signalAgentsForMessage(env, { messageId, channelId: row.channelId, authorId: member.user.id, authorName: member.user.displayName, content, mentionIds: added, edit: true }))
  }
  const [dto] = await hydrateMessages(env, [await loadMessage(env, messageId)], member.user.id)
  // The broadcast copy carries no viewer; each client keeps its own reaction highlight.
  await fanoutChannel(env, row.channelId, { t: 'message.update', message: { ...dto!, reactions: dto!.reactions.map(reaction => ({ ...reaction, me: false })) } })
  return { message: dto }
}

/** Idempotent add or remove of the member's own reaction; the interface toggles the same row. */
export async function setMessageReaction(env: L4Env, actor: Membership, messageId: string, input: { emoji: string; remove?: boolean }) {
  authorizeMcpCredential(actor.authorization, 'messages:write')
  const parsed = reactionEmojiSchema.safeParse(input.emoji)
  if (!parsed.success) fail(400, 'bad_request', 'Not an emoji')
  const emoji = parsed.data
  const row = await loadMessage(env, messageId)
  const member = await requireChannelAccessForMember(env, actor, row.channelId, undefined, 'POST')
  if (row.deletedAt) fail(409, 'deleted', 'Message was deleted')
  await requireRate(env, reactionRate(member.user.id), 'Too many reactions. Slow down.')
  const op = input.remove ? 'remove' as const : 'add' as const
  const result = op === 'add'
    ? await env.DB.prepare('INSERT OR IGNORE INTO message_reactions (message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)')
        .bind(messageId, member.user.id, emoji, nowIso()).run()
    : await env.DB.prepare('DELETE FROM message_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?')
        .bind(messageId, member.user.id, emoji).run()
  const changed = (result.meta.changes ?? 0) > 0
  if (changed) {
    await (await auditMcpWrite(env, actor, `message.reaction.${op}`, 'message', messageId, { channelId: row.channelId, emoji }))?.run()
    await fanoutChannel(env, row.channelId, { t: 'reaction', messageId, emoji, userId: member.user.id, op })
  }
  return { op, changed }
}

/** Same rules as PUT/DELETE /api/messages/:id/pin. */
export async function setMessagePin(env: L4Env, actor: Membership, messageId: string, input: { pinned: boolean }) {
  authorizeMcpCredential(actor.authorization, 'messages:write')
  const row = await loadMessage(env, messageId)
  const access = await requireChannelAccessForMember(env, actor, row.channelId, undefined, input.pinned ? 'PUT' : 'DELETE')
  if (!canManageMessagePins(access)) fail(403, 'forbidden', 'Missing permission')
  if (!input.pinned) {
    const removed = ((await env.DB.prepare('DELETE FROM message_pins WHERE message_id = ?').bind(messageId).run()).meta.changes ?? 0) > 0
    if (removed) {
      await (await auditMcpWrite(env, actor, 'message.unpin', 'message', messageId, { channelId: row.channelId }))?.run()
      await fanoutMessagePin(env, row.channelId, messageId, null)
    }
    return { pin: null, changed: removed }
  }
  if (row.deletedAt) fail(409, 'deleted', 'Message was deleted')
  const created = ((await env.DB.prepare(INSERT_MESSAGE_PIN_SQL).bind(messageId, access.user.id, nowIso()).run()).meta.changes ?? 0) > 0
  const pin = await loadMessagePin(env, messageId)
  if (!pin) fail(409, 'conflict', 'Message could not be pinned')
  if (created) {
    await (await auditMcpWrite(env, actor, 'message.pin', 'message', messageId, { channelId: row.channelId }))?.run()
    await fanoutMessagePin(env, row.channelId, messageId, pin)
  }
  return { pin, changed: created }
}

/** Open (or unhide) the 1:1 DM with another member, as POST /api/dms does. */
export async function openDirectMessage(env: L4Env, actor: Membership, userId: string) {
  authorizeMcpCredential(actor.authorization, 'messages:write')
  // A delegated Agent's DMs stay private from the human administering its token.
  if (actor.authorization.delegation) fail(403, 'forbidden', 'Delegated Agent connections cannot open direct messages')
  if (userId === actor.user.id) fail(400, 'bad_request', 'Cannot DM yourself')
  const other = (await getDb(env.DB).select().from(users).where(and(eq(users.id, userId), eq(users.status, 'active'))).limit(1))[0]
  if (!other) fail(404, 'not_found', 'Member not found')
  if (other.kind === 'agent' && !actor.isOwner && !hasPermission(actor.perms, Permission.useAgents)) {
    fail(403, 'forbidden', 'Use agents permission is required to add an Agent')
  }
  const id = await openPairDm(env, actor.user.id, userId)
  await (await auditMcpWrite(env, actor, 'dm.open', 'channel', id, { userId }))?.run()
  const access = await requireChannelAccessForMember(env, actor, id)
  return { channel: { id, type: access.channel.type, participants: access.participants, frozen: access.frozen,
    canSend: !access.frozen && hasPermission(access.perms, Permission.sendMessages) } }
}
