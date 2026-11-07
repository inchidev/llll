import { getProjectGitFlow } from '../../../utils/project-git-flow'
import { cf } from '../../../utils/cf'
import { requireMember } from '../../../utils/guards'
import { getServerId } from '../../../../shared/server-id'
export default defineEventHandler(async event => {
  setHeader(event, 'Cache-Control', 'private, no-store')
  const { env } = cf(event)
  const actor = await requireMember(event, await getServerId(env.DB))
  return getProjectGitFlow(env, actor.authorization, getRouterParam(event, 'id')!)
})
