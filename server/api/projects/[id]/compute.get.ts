import { getProjectCompute } from '../../../utils/project-compute'
import { cf } from '../../../utils/cf'
import { requireMember } from '../../../utils/guards'
import { getServerId } from '../../../../shared/server-id'
export default defineEventHandler(async event => {
  setHeader(event, 'Cache-Control', 'private, no-store')
  const { env } = cf(event)
  const actor = await requireMember(event, await getServerId(env.DB))
  return getProjectCompute(env, actor.authorization, getRouterParam(event, 'id')!)
})
