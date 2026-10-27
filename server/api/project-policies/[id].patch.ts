import { saveProjectPolicy } from '../../utils/project-policies'
import { requireMember } from '../../utils/guards'
import { getServerId } from '../../../shared/server-id'
import { cf } from '../../utils/cf'
export default defineEventHandler(async event => {
  const { env } = cf(event), actor = await requireMember(event, await getServerId(env.DB))
  return { policy: await saveProjectPolicy(env, actor.authorization, await readBody(event), getRouterParam(event, 'id')!) }
})
