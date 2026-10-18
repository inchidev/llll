import { getServerId } from '../../../../shared/server-id'
import type { GadgetRuntimeDTO } from '../../../../shared/gadgets'
import { cf } from '../../../utils/cf'
import { requireMember } from '../../../utils/guards'
import { openGadget } from '../../../utils/gadget-runtime'

export default defineEventHandler(async (event): Promise<GadgetRuntimeDTO> => {
  const actor = await requireMember(event, (await getServerId(cf(event).env.DB)))
  return openGadget(cf(event).env, actor, getRouterParam(event, 'id')!)
})
