import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { channelCategories, channels } from '../../../drizzle/schema'
import { nowIso } from '../../../shared/ids'
import { Permission } from '../../../shared/permissions'
import { requireChannelMember } from '../../utils/guards'
import { cf, fail } from '../../utils/cf'
import { getDb } from '../../utils/db'
import { parseBody } from '../../utils/validate'
import { writeAudit } from '../../utils/messages'

const bodySchema = z.object({
  name: z.string().min(1).max(80).optional(),
  topic: z.string().max(200).optional(),
  categoryId: z.string().min(8).nullable().optional(),
})

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const member = await requireChannelMember(event, id, Permission.manageChannels)
  const body = parseBody(bodySchema, await readBody(event))
  const { env } = cf(event)
  const db = getDb(env.DB)
  if (body.categoryId !== undefined && (member.channel.type === 'dm' || member.channel.type === 'thread')) {
    fail(400, 'bad_request', 'Only workspace channels can belong to categories')
  }
  if (body.categoryId) {
    const category = await db.select({ id: channelCategories.id }).from(channelCategories)
      .where(eq(channelCategories.id, body.categoryId)).limit(1)
    if (!category[0]) fail(400, 'bad_request', 'Channel category not found')
  }
  const patch: Partial<typeof channels.$inferInsert> = { updatedAt: nowIso() }
  if (body.name) patch.name = body.name.trim().toLowerCase()
  if (body.topic !== undefined) patch.topic = body.topic
  if (body.categoryId !== undefined) patch.categoryId = body.categoryId
  if (Object.keys(patch).length > 1) {
    await db.update(channels).set(patch).where(eq(channels.id, id))
    await writeAudit(env, {
      workspaceId: member.workspaceId,
      actorId: member.user.id,
      action: 'channel.update',
      targetType: 'channel',
      targetId: id,
      meta: { fields: Object.keys(body) },
    })
  }
  const row = (await db.select().from(channels).where(eq(channels.id, id)).limit(1))[0]
  return { channel: row }
})
