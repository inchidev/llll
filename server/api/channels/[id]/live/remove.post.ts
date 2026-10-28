import { z } from 'zod'
import { requireChannelAccess } from '../../../../utils/guards'
import { cf } from '../../../../utils/cf'
import { failLive, liveRoom } from '../../../../utils/live'
import { writeAudit } from '../../../../utils/messages'
import { parseBody } from '../../../../utils/validate'

const bodySchema = z.object({ userId: z.string().min(8).max(80) })

/** A host removes someone from the Live room. The room decides who is a host. */
export default defineEventHandler(async (event) => {
  const channelId = getRouterParam(event, 'id')!
  const access = await requireChannelAccess(event, channelId)
  const { userId } = parseBody(bodySchema, await readBody(event))
  const { env } = cf(event)
  const result = await liveRoom(env, channelId).removeLiveParticipant(access.user.id, userId)
  if (!result.ok) failLive(result)
  await writeAudit(env, {
    serverId: access.serverId,
    actorId: access.user.id,
    action: 'live.remove',
    targetType: 'channel',
    targetId: channelId,
    meta: { userId },
  })
  return { live: result.live }
})
