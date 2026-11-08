import { createProjectRelease } from '../../../utils/factory-artifacts'
import { requireMember } from '../../../utils/guards'
import { getServerId } from '../../../../shared/server-id'
import { cf } from '../../../utils/cf'
/** A version of the Project's repository in L4: an annotated tag `v<version>` on its base branch. */
export default defineEventHandler(async event => {
  setHeader(event, 'Cache-Control', 'private, no-store')
  const { env } = cf(event), actor = await requireMember(event, await getServerId(env.DB))
  return { release: await createProjectRelease(env, actor.authorization, getRouterParam(event, 'id')!, await readBody(event)) }
})
