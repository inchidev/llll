import { requireChannelAccess } from '../../../utils/guards'
import { cf } from '../../../utils/cf'
import { chatAttention } from '../../../../workers/chat-attention'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const access = await requireChannelAccess(event, id)
  return chatAttention(cf(event).env.DB, id, access.user.id)
})
