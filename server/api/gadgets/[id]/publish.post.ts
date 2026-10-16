import { z } from 'zod'
import type { GadgetDetailDTO } from '../../../../shared/gadgets'
import { WORKSPACE_ID } from '../../../../shared/ids'
import { cf } from '../../../utils/cf'
import { publishGadget } from '../../../utils/gadget-catalog'
import { requireMember } from '../../../utils/guards'
import { parseBody } from '../../../utils/validate'

const bodySchema = z.object({ revision: z.number().int().positive() })

export default defineEventHandler(async (event): Promise<{ gadget: GadgetDetailDTO }> => {
  const actor = await requireMember(event, WORKSPACE_ID)
  const body = parseBody(bodySchema, await readBody(event))
  return { gadget: await publishGadget(cf(event).env, actor, getRouterParam(event, 'id')!, body.revision) }
})
