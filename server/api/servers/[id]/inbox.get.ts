import { cf } from '../../../utils/cf'
import { requireMember } from '../../../utils/guards'
import { loadInbox } from '../../../utils/inbox-service'

export default defineEventHandler(async (event) => {
  const member = await requireMember(event, getRouterParam(event, 'id')!)
  setHeader(event, 'Cache-Control', 'no-store')
  return loadInbox(cf(event).env, member)
})
