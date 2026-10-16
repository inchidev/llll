import { and, eq, ne } from 'drizzle-orm'
import { z } from 'zod'
import { channelCategories } from '../../../../../drizzle/schema'
import { nowIso } from '../../../../../shared/ids'
import { Permission } from '../../../../../shared/permissions'
import { requireMember } from '../../../../utils/guards'
import { cf, fail } from '../../../../utils/cf'
import { getDb } from '../../../../utils/db'
import { writeAudit } from '../../../../utils/messages'
import { parseBody } from '../../../../utils/validate'

const bodySchema = z.object({
  name: z.string().trim().min(1).max(80),
})

export default defineEventHandler(async (event) => {
  const workspaceId = getRouterParam(event, 'id')!
  const categoryId = getRouterParam(event, 'categoryId')!
  const member = await requireMember(event, workspaceId, Permission.manageChannels)
  const body = parseBody(bodySchema, await readBody(event))
  const { env } = cf(event)
  const db = getDb(env.DB)
  const existing = await db.select({ id: channelCategories.id }).from(channelCategories)
    .where(eq(channelCategories.id, categoryId)).limit(1)
  if (!existing[0]) fail(404, 'not_found', 'Channel category not found')
  const duplicate = await db.select({ id: channelCategories.id }).from(channelCategories)
    .where(and(ne(channelCategories.id, categoryId), eq(channelCategories.name, body.name))).limit(1)
  if (duplicate[0]) fail(409, 'conflict', 'A channel category with that name already exists')

  await db.update(channelCategories).set({ name: body.name, updatedAt: nowIso() })
    .where(eq(channelCategories.id, categoryId))
  await writeAudit(env, {
    workspaceId,
    actorId: member.user.id,
    action: 'channel_category.update',
    targetType: 'channel_category',
    targetId: categoryId,
    meta: { name: body.name },
  })
  const category = (await db.select().from(channelCategories).where(eq(channelCategories.id, categoryId)).limit(1))[0]
  return { category }
})
