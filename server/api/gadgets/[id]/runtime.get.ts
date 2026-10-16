import type { GadgetRuntimeDTO } from '../../../../shared/gadgets'
import { WORKSPACE_ID } from '../../../../shared/ids'
import { cf } from '../../../utils/cf'
import { requireMember } from '../../../utils/guards'
import { openGadget } from '../../../utils/gadget-runtime'

export default defineEventHandler(async (event): Promise<GadgetRuntimeDTO> => {
  const actor = await requireMember(event, WORKSPACE_ID)
  return openGadget(cf(event).env, actor, getRouterParam(event, 'id')!)
})
