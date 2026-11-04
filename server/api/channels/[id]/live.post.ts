import { z } from 'zod'
import { requireChannelAccess } from '../../../utils/guards'
import { cf } from '../../../utils/cf'
import { failLive, liveRoom } from '../../../utils/live'
import { parseBody } from '../../../utils/validate'

/** A reconnect names the meeting it dropped from, so an ended room is not started again. */
const bodySchema = z.object({ meetingId: z.string().min(1).max(200).optional() }).nullish()

/** Join the conversation's Live room, starting it when it is idle. Returns the RealtimeKit participant token. */
export default defineEventHandler(async (event) => {
  const channelId = getRouterParam(event, 'id')!
  const access = await requireChannelAccess(event, channelId)
  const body = parseBody(bodySchema, await readBody(event).catch(() => null))
  const { env } = cf(event)
  const { id, kind, displayName, avatarR2Key } = access.user
  const result = await liveRoom(env, channelId).joinLive({ id, kind, displayName, avatarR2Key }, { meetingId: body?.meetingId })
  if (!result.ok) failLive(result)
  setHeader(event, 'Cache-Control', 'no-store')
  return { token: result.token, meetingId: result.meetingId, live: result.live }
})
