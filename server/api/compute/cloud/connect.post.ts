import { cf } from '../../../utils/cf'
import { requireMember } from '../../../utils/guards'
import { getServerId } from '../../../../shared/server-id'
import { beginL4ComputeLink } from '../../../utils/l4-compute'
/** Add L4 Compute: where the Owner's browser goes on llll.gg, with a nonce this Server checks when it comes back. */
export default defineEventHandler(async event => {
  setHeader(event, 'Cache-Control', 'private, no-store')
  const { env } = cf(event), actor = await requireMember(event, await getServerId(env.DB))
  return beginL4ComputeLink(env, actor.authorization)
})
