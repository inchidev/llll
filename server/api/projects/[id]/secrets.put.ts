import { createProjectSecret } from '../../../utils/project-egress'
import { projectSecretCreateSchema } from '../../../../shared/project-factory'
import { cf } from '../../../utils/cf'
import { requireMember } from '../../../utils/guards'
import { getServerId } from '../../../../shared/server-id'
import { parseBody } from '../../../utils/validate'
export default defineEventHandler(async event => {
  setHeader(event, 'Cache-Control', 'private, no-store')
  const { env } = cf(event)
  const actor = await requireMember(event, await getServerId(env.DB))
  return { secret: await createProjectSecret(env, actor.authorization, getRouterParam(event, 'id')!, parseBody(projectSecretCreateSchema, await readBody(event))) }
})
