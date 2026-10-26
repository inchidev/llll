import { requireProject, listProjectRepositories } from '../../utils/project-service'
import { cf } from '../../utils/cf'
import { requireMember } from '../../utils/guards'
import { getServerId } from '../../../shared/server-id'
export default defineEventHandler(async event => {
  setHeader(event, 'Cache-Control', 'private, no-store')
  const { env } = cf(event)
  const actor = await requireMember(event, await getServerId(env.DB))
  const id = getRouterParam(event, 'id')!
  return { project: await requireProject(env, actor.authorization, id), repositories: await listProjectRepositories(env, actor.authorization, id) }
})
