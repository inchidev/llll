import { cf } from '../../../../utils/cf'
import { requireMember } from '../../../../utils/guards'
import { loadSpaceAttention } from '../../../../utils/space-attention'

/** Which of the caller's own Spaces have something new. About the caller, across their Spaces. */
export default defineEventHandler(async (event) => {
  const member = await requireMember(event, getRouterParam(event, 'id')!)
  setHeader(event, 'Cache-Control', 'private, no-store')
  return loadSpaceAttention(cf(event).env, member)
})
