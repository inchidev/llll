import type { GadgetListDTO } from '../../../../shared/gadgets'
import { cf } from '../../../utils/cf'
import { listGadgets } from '../../../utils/gadget-catalog'
import { requireMember } from '../../../utils/guards'

export default defineEventHandler(async (event): Promise<GadgetListDTO> => {
  const workspaceId = getRouterParam(event, 'id')!
  const actor = await requireMember(event, workspaceId)
  return listGadgets(cf(event).env, actor)
})
