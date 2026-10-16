import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { messages } from '../../../drizzle/schema'
import { extractMentionIds } from '../../../shared/mentions'
import { nowIso } from '../../../shared/ids'
import { Permission } from '../../../shared/permissions'
import { requireChannelMember } from '../../utils/guards'
import { cf, fail } from '../../utils/cf'
import { getDb } from '../../utils/db'
import { hydrateMessages } from '../../utils/messages'
import { parseBody } from '../../utils/validate'

const bodySchema = z.object({
  content: z.string().min(1).max(2000),
})

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const { env } = cf(event)
  const db = getDb(env.DB)
  const row = (await db.select().from(messages).where(eq(messages.id, id)).limit(1))[0]
  if (!row) fail(404, 'not_found', 'Message not found')
  if (row.deletedAt) fail(409, 'deleted', 'Message was deleted')
  const member = await requireChannelMember(event, row.channelId, Permission.sendMessages)
  if (row.authorId !== member.user.id) fail(403, 'forbidden', 'Not your message')
  const body = parseBody(bodySchema, await readBody(event))
  const editedAt = nowIso()
  const requestedMentions = extractMentionIds(body.content)
  let mentionIds: string[] = []
  if (requestedMentions.length) {
    const placeholders = requestedMentions.map(() => '?').join(',')
    const rows = await env.DB.prepare(
      `SELECT id FROM users WHERE id IN (${placeholders}) AND status = 'active'`,
    ).bind(...requestedMentions).all<{ id: string }>()
    mentionIds = (rows.results ?? []).map((mention) => mention.id)
  }
  await env.DB.batch([
    env.DB.prepare('UPDATE messages SET content = ?, edited_at = ? WHERE id = ?').bind(body.content, editedAt, id),
    env.DB.prepare('DELETE FROM message_mentions WHERE message_id = ?').bind(id),
    ...mentionIds.map((userId) => env.DB.prepare(
      'INSERT OR IGNORE INTO message_mentions (message_id, user_id) VALUES (?, ?)',
    ).bind(id, userId)),
  ])
  const updated = (await db.select().from(messages).where(eq(messages.id, id)).limit(1))[0]!
  const [dto] = await hydrateMessages(env, [updated])
  try {
    const stub = asRpc<{ fanout: (msg: unknown) => Promise<void> }>(env.CHANNEL_DO.getByName(`channel:${row.channelId}`))
    await stub.fanout({ t: 'message.update', message: dto })
  }
  catch { /* ignore */ }
  return { message: dto }
})
