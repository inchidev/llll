import { revokeProjectPolicy } from '../../../../utils/project-policies'
import { requireMember } from '../../../../utils/guards'
import { getServerId } from '../../../../../shared/server-id'
import { cf } from '../../../../utils/cf'
export default defineEventHandler(async event => {
  const { env } = cf(event), actor = await requireMember(event, await getServerId(env.DB))
  await revokeProjectPolicy(env, actor.authorization, getRouterParam(event, 'id')!, getRouterParam(event, 'assignment')!)
  return { ok: true }
})
