import { requirePolicyManager, listProjectPolicies } from '../../../utils/project-policies'
import { requireMember } from '../../../utils/guards'
import { cf } from '../../../utils/cf'
export default defineEventHandler(async event => {
  setHeader(event, 'Cache-Control', 'private, no-store')
  const actor = await requireMember(event, getRouterParam(event, 'id')!)
  requirePolicyManager(actor.authorization)
  return { policies: await listProjectPolicies(cf(event).env) }
})
