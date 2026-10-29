import { requireMember } from '../../../../utils/guards'
import { cf, fail, originOk } from '../../../../utils/cf'
import { deploymentProviderState, saveDeploymentProvider } from '../../../../utils/agent-deployment-provider'

export default defineEventHandler(async event => {
  if (!await originOk(event)) fail(403, 'origin_denied', 'Change model providers from this Server')
  const member = await requireMember(event, getRouterParam(event, 'id')!)
  if (!member.isOwner) fail(403, 'forbidden', 'Only the owner can configure model providers')
  const { env } = cf(event)
  await saveDeploymentProvider(env, await readBody(event))
  return deploymentProviderState(env)
})
