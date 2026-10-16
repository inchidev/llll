import { z } from 'zod'
import type { GadgetDetailDTO, GadgetSpec } from '../../../shared/gadgets'
import { WORKSPACE_ID } from '../../../shared/ids'
import { cf } from '../../utils/cf'
import { updateGadget } from '../../utils/gadget-catalog'
import { requireMember } from '../../utils/guards'
import { parseBody } from '../../utils/validate'

const bodySchema = z.object({
  revision: z.number().int().positive(),
  name: z.string().trim().min(1).max(80).optional(),
  description: z.string().trim().max(500).optional(),
  spec: z.unknown().optional(),
  roleIds: z.array(z.string().min(1)).max(64).optional(),
}).refine(body => Object.keys(body).some(key => key !== 'revision'), 'No changes')

export default defineEventHandler(async (event): Promise<{ gadget: GadgetDetailDTO }> => {
  const actor = await requireMember(event, WORKSPACE_ID)
  const body = parseBody(bodySchema, await readBody(event))
  return {
    gadget: await updateGadget(cf(event).env, actor, getRouterParam(event, 'id')!, {
      ...body,
      spec: body.spec as GadgetSpec | undefined,
    }),
  }
})
