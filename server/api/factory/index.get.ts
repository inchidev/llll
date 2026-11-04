import { cf } from '../../utils/cf'
import { getServerId } from '../../../shared/server-id'
import { requireMember } from '../../utils/guards'
import { factorySetup } from '../../utils/factory-setup'
export default defineEventHandler(async event => {
  setHeader(event, 'Cache-Control', 'private, no-store')
  const { env } = cf(event), actor = await requireMember(event, await getServerId(env.DB))
  return factorySetup(env, actor.authorization)
})
