import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { attachments, channels, messages } from '../../../../drizzle/schema'
import { newId, nowIso } from '../../../../shared/ids'
import { messageThreadTitle, updateNewThreadTitle } from '../../../utils/thread-title'
import { Permission } from '../../../../shared/permissions'
import { requireChannelAccess } from '../../../utils/guards'
import { asRpc, cf, fail } from '../../../utils/cf'
import { getDb } from '../../../utils/db'
import { parseBody } from '../../../utils/validate'

const bodySchema = z.object({
  messageId: z.string().min(8),
  name: z.string().min(1).max(80).optional(),
})

export default defineEventHandler(async (event) => {
  const parentId = getRouterParam(event, 'id')!
  const access = await requireChannelAccess(event, parentId, Permission.sendMessages)
  if (access.channel.type !== 'text' && access.channel.type !== 'dm') fail(400, 'bad_request', 'Threads hang off text or DMs')
  const body = parseBody(bodySchema, await readBody(event))
  const { env, waitUntil } = cf(event)
  const db = getDb(env.DB)
  // Independent lookups run together; each D1 round trip is noticeable here.
  const [msgRows, existingRows, attachmentRows] = await Promise.all([
    db.select().from(messages).where(and(eq(messages.id, body.messageId), eq(messages.channelId, parentId))).limit(1),
    db.select().from(channels).where(eq(channels.parentMessageId, body.messageId)).limit(1),
    db.select({ filename: attachments.filename }).from(attachments).where(eq(attachments.messageId, body.messageId)),
  ])
  const msg = msgRows[0]
  if (!msg || msg.deletedAt) fail(404, 'not_found', 'Message not found')
  const existing = existingRows[0]
  if (existing) return { channel: { ...existing, title: await messageThreadTitle(env.DB, existing.name || msg.content, attachmentRows.map(row => row.filename)) }, created: false }
  const title = body.name?.trim() || await messageThreadTitle(env.DB, msg.content, attachmentRows.map(row => row.filename))
  const created = nowIso()
  const row = (await db.insert(channels).values({
    id: newId(),
    name: title,
    topic: '',
    type: 'thread',
    visibility: access.channel.visibility,
    position: 0,
    liveMeetingId: null,
    parentId,
    parentMessageId: body.messageId,
    createdAt: created,
    updatedAt: created,
  }).returning())[0]!
  // Other open clients learn about the thread chip without reloading; a lost event never fails creation.
  waitUntil((async () => asRpc<{ fanout: (event: unknown) => Promise<void> }>(env.CHANNEL_DO.getByName(`channel:${parentId}`))
    .fanout({ t: 'thread.created', messageId: body.messageId, threadId: row.id }))().catch(() => {}))
  if (!body.name?.trim()) waitUntil(updateNewThreadTitle(env, access.authorization, row.id, title))
  return { channel: { ...row, title }, created: true }
})
