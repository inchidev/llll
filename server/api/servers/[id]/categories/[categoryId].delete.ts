import { eq } from 'drizzle-orm'
import { channelCategories, channels } from '../../../../../drizzle/schema'
import { Permission } from '../../../../../shared/permissions'
import { requireMember } from '../../../../utils/guards'
import { cf, fail } from '../../../../utils/cf'
import { getDb } from '../../../../utils/db'
import { writeAudit } from '../../../../utils/messages'

export default defineEventHandler(async (event) => {
  const serverId = getRouterParam(event, 'id')!
  const categoryId = getRouterParam(event, 'categoryId')!
  const member = await requireMember(event, serverId, Permission.manageChannels)
  const { env } = cf(event)
  const db = getDb(env.DB)
  const category = (await db.select().from(channelCategories).where(eq(channelCategories.id, categoryId)).limit(1))[0]
  if (!category) fail(404, 'not_found', 'Channel category not found')

  await db.update(channels).set({ categoryId: null }).where(eq(channels.categoryId, categoryId))
  await db.delete(channelCategories).where(eq(channelCategories.id, categoryId))
  await writeAudit(env, {
    serverId,
    actorId: member.user.id,
    action: 'channel_category.delete',
    targetType: 'channel_category',
    targetId: categoryId,
    meta: { name: category.name },
  })
  return { ok: true }
})
