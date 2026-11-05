import { cf } from '../../../utils/cf'
import { requireMember } from '../../../utils/guards'
import { integrationsStatus, requireIntegrationOwner } from '../../../utils/integrations'

export default defineEventHandler(async event => {
  setHeader(event, 'Cache-Control', 'no-store')
  const member = await requireMember(event, getRouterParam(event, 'id')!)
  requireIntegrationOwner(member)
  const { env } = cf(event)
  return integrationsStatus(env, member.user.id, getRequestURL(event).origin)
})
