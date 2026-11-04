import { addProjectRepository } from '../../../utils/project-service'
import { projectRepositorySchema } from '../../../../shared/projects'
import { cf } from '../../../utils/cf'
import { requireMember } from '../../../utils/guards'
import { getServerId } from '../../../../shared/server-id'
import { parseBody } from '../../../utils/validate'
export default defineEventHandler(async event => {
  setHeader(event, 'Cache-Control', 'private, no-store')
  const { env } = cf(event)
  const actor = await requireMember(event, await getServerId(env.DB))
  return { repository: await addProjectRepository(env, actor.authorization, getRouterParam(event, 'id')!, parseBody(projectRepositorySchema, await readBody(event))) }
})
