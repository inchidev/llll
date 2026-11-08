import { createProjectRepository } from '../../../utils/factory-artifacts'
import { requireMember } from '../../../utils/guards'
import { getServerId } from '../../../../shared/server-id'
import { cf } from '../../../utils/cf'
/** A repository for this Project inside L4 (ADR 0013): created in the Server's own Artifacts namespace and attached. */
export default defineEventHandler(async event => {
  setHeader(event, 'Cache-Control', 'private, no-store')
  const { env } = cf(event), actor = await requireMember(event, await getServerId(env.DB))
  return createProjectRepository(env, actor.authorization, getRouterParam(event, 'id')!, await readBody(event) ?? {})
})
