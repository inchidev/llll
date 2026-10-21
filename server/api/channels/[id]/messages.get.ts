import { requireMember } from '../../../utils/guards'
import { getServerId } from '../../../../shared/server-id'
import { cf } from '../../../utils/cf'
import { readChannelMessages } from '../../../utils/message-service'

export default defineEventHandler(async (event) => {
  const { env } = cf(event)
  const actor = await requireMember(event, await getServerId(env.DB))
  const query = getQuery(event)
  return readChannelMessages(env, actor, getRouterParam(event, 'id')!, {
    limit: Number(query.limit) || 50,
    cursor: typeof query.cursor === 'string' ? query.cursor : null,
  })
})
