import { cf } from '../../../utils/cf'
import { requireMember } from '../../../utils/guards'
import { getServerId } from '../../../../shared/server-id'
import { requireComputeOwner } from '../../../utils/compute-nodes'
import { l4ComputeOverview } from '../../../utils/l4-compute'
/** L4 Compute as Settings → Compute shows it: linked or not, the account, and what llll.gg reports about credit. */
export default defineEventHandler(async event => {
  setHeader(event, 'Cache-Control', 'private, no-store')
  const { env } = cf(event), actor = await requireMember(event, await getServerId(env.DB))
  requireComputeOwner(actor.authorization)
  return l4ComputeOverview(env)
})
