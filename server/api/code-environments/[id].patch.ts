import { Permission } from '../../../shared/permissions'
import { getServerId } from '../../../shared/server-id'
import { codeEnvironmentSchema } from '../../../shared/code-environments'
import { cf } from '../../utils/cf'
import { requireMember } from '../../utils/guards'
import { parseBody } from '../../utils/validate'
import { saveCodeEnvironment } from '../../utils/code-environment-service'

export default defineEventHandler(async event => {
  const { env } = cf(event)
  const actor = await requireMember(event, await getServerId(env.DB), Permission.manageServer)
  return { environment: await saveCodeEnvironment(env, actor.authorization, parseBody(codeEnvironmentSchema, await readBody(event)), getRouterParam(event, 'id')!) }
})
