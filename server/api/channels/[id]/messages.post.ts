import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { messages } from '../../../../drizzle/schema'
import { extractMentionIds } from '../../../../shared/mentions'
import { newId, nowIso } from '../../../../shared/ids'
import { hasPermission, Permission } from '../../../../shared/permissions'
import { requireChannelMember } from '../../../utils/guards'
import { cf, fail } from '../../../utils/cf'
import { getDb } from '../../../utils/db'
import { hydrateMessages } from '../../../utils/messages'
import { parseBody } from '../../../utils/validate'
import { messageNotificationStatement, signalNotificationOutbox } from '../../../../workers/notifications'
import { signalChannelActivity, signalChannelRead } from '../../../../workers/channel-activity'
import { signalAgentsForMessage } from '../../../../workers/agent-ingress'

const bodySchema = z.object({
  content: z.string().max(2000),
  replyToId: z.string().min(8).optional(),
  clientId: z.string().min(1).max(80).optional(),
  attachmentIds: z.array(z.string().min(8)).max(8).optional(),
  agentMode: z.enum(['queue', 'steer']).optional(),
})

export default defineEventHandler(async (event) => {
  const channelId = getRouterParam(event, 'id')!
  const member = await requireChannelMember(event, channelId, Permission.sendMessages)
  const body = parseBody(bodySchema, await readBody(event))
  if (!body.content.trim() && !body.attachmentIds?.length) fail(400, 'bad_request', 'Empty message')
  if (body.attachmentIds?.length && !hasPermission(member.perms, Permission.attachFiles)) {
    fail(403, 'forbidden', 'Missing permission')
  }

  const { env, waitUntil } = cf(event)
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

  const id = newId()
  const created = nowIso()
  const notification = await messageNotificationStatement(env, {
    id,
    channelId,
    author: member.user,
    content: body.content,
    mentions: mentionIds,
    attachmentCount: attachmentRows.length,
  })
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
  ])
  waitUntil(signalNotificationOutbox(env))
  waitUntil(signalChannelActivity(env, {
    id,
    channelId,
    author: member.user,
    content: body.content,
    attachmentCount: attachmentRows.length,
  }))
  waitUntil(signalChannelRead(env, member.user.id, channelId, id))
  const db = getDb(env.DB)
  const row = (await db.select().from(messages).where(eq(messages.id, id)).limit(1))[0]!
  const [dto] = await hydrateMessages(env, [row], member.user.id)
  try {
    const stub = asRpc<{ fanout: (msg: unknown) => Promise<void> }>(env.CHANNEL_DO.getByName(`channel:${channelId}`))
    await stub.fanout({ t: 'message', message: dto })
  }
  catch { /* local without DO */ }
  waitUntil(signalAgentsForMessage(env, {
    messageId: id,
    channelId,
    authorId: member.user.id,
    authorName: member.user.displayName,
    content: body.content,
    mentionIds,
    mode: body.agentMode,
  }))
  return { message: dto }
})
