import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { attachments, channels, messages } from '../../../../drizzle/schema'
import { newId, nowIso } from '../../../../shared/ids'
import { threadTitle } from '../../../../shared/threads'
import { Permission } from '../../../../shared/permissions'
import { requireChannelAccess } from '../../../utils/guards'
import { cf, fail } from '../../../utils/cf'
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
  const { env } = cf(event)
  const db = getDb(env.DB)
  // Independent lookups run together; each D1 round trip is noticeable here.
  const [msgRows, existingRows, attachmentRows] = await Promise.all([
    db.select().from(messages).where(and(eq(messages.id, body.messageId), eq(messages.channelId, parentId))).limit(1),
    db.select().from(channels).where(eq(channels.parentMessageId, body.messageId)).limit(1),
    db.select({ filename: attachments.filename }).from(attachments).where(eq(attachments.messageId, body.messageId)),
  ])
  const msg = msgRows[0]
  if (!msg) fail(404, 'not_found', 'Message not found')
  const existing = existingRows[0]
  const title = body.name?.trim() || threadTitle(msg.content, attachmentRows.map(row => row.filename))
  if (existing) return { channel: { ...existing, title }, created: false }
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
  return { channel: { ...row, title }, created: true }
})
