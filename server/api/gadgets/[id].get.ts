import type { GadgetDetailDTO } from '../../../shared/gadgets'
import { WORKSPACE_ID } from '../../../shared/ids'
import { cf } from '../../utils/cf'
import { getGadgetDetail } from '../../utils/gadget-catalog'
import { requireMember } from '../../utils/guards'

export default defineEventHandler(async (event): Promise<{ gadget: GadgetDetailDTO }> => {
  const actor = await requireMember(event, WORKSPACE_ID)
  return { gadget: await getGadgetDetail(cf(event).env, actor, getRouterParam(event, 'id')!) }
})
