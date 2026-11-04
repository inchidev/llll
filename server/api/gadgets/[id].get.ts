import { getServerId } from '../../../shared/server-id'
import type { GadgetDetailDTO } from '../../../shared/gadgets'
import { cf } from '../../utils/cf'
import { getGadgetDetail } from '../../utils/gadget-catalog'
import { requireMember } from '../../utils/guards'

export default defineEventHandler(async (event): Promise<{ gadget: GadgetDetailDTO }> => {
  const actor = await requireMember(event, (await getServerId(cf(event).env.DB)))
  return { gadget: await getGadgetDetail(cf(event).env, actor, getRouterParam(event, 'id')!) }
})
