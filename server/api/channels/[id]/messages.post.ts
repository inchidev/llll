import { requireMember } from '../../../utils/guards'
import { getServerId } from '../../../../shared/server-id'
import { cf } from '../../../utils/cf'
import { sendChannelMessage, sendMessageSchema } from '../../../utils/message-service'
import { parseBody } from '../../../utils/validate'

export default defineEventHandler(async (event) => {
  const { env, waitUntil } = cf(event)
  const actor = await requireMember(event, await getServerId(env.DB))
  const body = parseBody(sendMessageSchema, await readBody(event))
  return sendChannelMessage(env, actor, getRouterParam(event, 'id')!, body, waitUntil)
})
