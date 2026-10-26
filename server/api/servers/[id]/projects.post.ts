import { createProject } from '../../../utils/project-service'
import { projectSchema } from '../../../../shared/projects'
import { cf } from '../../../utils/cf'
import { requireMember } from '../../../utils/guards'
import { parseBody } from '../../../utils/validate'
export default defineEventHandler(async event => {
  setHeader(event, 'Cache-Control', 'private, no-store')
  const { env } = cf(event)
  const actor = await requireMember(event, getRouterParam(event, 'id')!)
  return { project: await createProject(env, actor.authorization, parseBody(projectSchema, await readBody(event))) }
})
