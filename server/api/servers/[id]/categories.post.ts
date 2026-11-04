import { z } from 'zod'
import { channelCategories } from '../../../../drizzle/schema'
import { newId, nowIso } from '../../../../shared/ids'
import { Permission } from '../../../../shared/permissions'
import { creationSpaceId } from '../../../../shared/spaces'
import { requireMember } from '../../../utils/guards'
import { cf, fail } from '../../../utils/cf'
import { getDb } from '../../../utils/db'
import { writeAudit } from '../../../utils/messages'
import { signalChannelsChanged } from '../../../utils/channel-lifecycle'
import { parseBody } from '../../../utils/validate'

const bodySchema = z.object({
  name: z.string().trim().min(1).max(80),
})

export default defineEventHandler(async (event) => {
  const serverId = getRouterParam(event, 'id')!
  const member = await requireMember(event, serverId, Permission.manageChannels)
  const spaceId = creationSpaceId(member.authorization)
  if (!spaceId) fail(403, 'forbidden', 'Choose a Space first')
  const body = parseBody(bodySchema, await readBody(event))
  const { env, waitUntil } = cf(event)
  const db = getDb(env.DB)
  const id = newId()
  const createdAt = nowIso()
  const position = Number((await env.DB.prepare('SELECT COALESCE(MAX(position),0)+1 AS position FROM channel_categories WHERE space_id=?').bind(spaceId).first<{ position: number }>())?.position ?? 1)

  await db.insert(channelCategories).values({
    id,
    spaceId,
    name: body.name,
    position,
    createdAt,
    updatedAt: createdAt,
  })
  await writeAudit(env, {
    serverId,
    actorId: member.user.id,
    action: 'channel_category.create',
    targetType: 'channel_category',
    targetId: id,
    meta: { name: body.name },
  })

  waitUntil(signalChannelsChanged(env, serverId))
  return { category: { id, name: body.name, position, createdAt } }
})
