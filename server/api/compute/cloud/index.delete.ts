import { cf } from '../../../utils/cf'
import { requireMember } from '../../../utils/guards'
import { getServerId } from '../../../../shared/server-id'
import { disconnectL4Compute } from '../../../utils/l4-compute'
export default defineEventHandler(async event => {
  setHeader(event, 'Cache-Control', 'private, no-store')
  const { env } = cf(event), actor = await requireMember(event, await getServerId(env.DB))
  await disconnectL4Compute(env, actor.authorization)
  return { disconnected: true }
})
