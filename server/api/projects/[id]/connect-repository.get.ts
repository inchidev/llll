import { repositoryConnectOptions } from '../../../utils/repository-connect'
import { requireMember } from '../../../utils/guards'
import { getServerId } from '../../../../shared/server-id'
import { cf } from '../../../utils/cf'
export default defineEventHandler(async event => {
  setHeader(event, 'Cache-Control', 'private, no-store')
  const { env } = cf(event), actor = await requireMember(event, await getServerId(env.DB))
  return repositoryConnectOptions(env, actor.authorization, getRouterParam(event, 'id')!)
})
