import { Permission } from '../../../shared/permissions'
import { getServerId } from '../../../shared/server-id'
import { cf } from '../../utils/cf'
import { requireMember } from '../../utils/guards'
import { disableCodeEnvironment } from '../../utils/code-environment-service'

export default defineEventHandler(async event => {
  const { env } = cf(event)
  const actor = await requireMember(event, await getServerId(env.DB), Permission.manageServer)
  await disableCodeEnvironment(env, actor.authorization, getRouterParam(event, 'id')!)
  return { disabled: true }
})
