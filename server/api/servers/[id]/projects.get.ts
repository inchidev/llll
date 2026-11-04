import { listProjects } from '../../../utils/project-service'
import { cf } from '../../../utils/cf'
import { requireMember } from '../../../utils/guards'
export default defineEventHandler(async event => {
  setHeader(event, 'Cache-Control', 'private, no-store')
  const { env } = cf(event)
  const actor = await requireMember(event, getRouterParam(event, 'id')!)
  return { projects: await listProjects(env, actor.authorization) }
})
