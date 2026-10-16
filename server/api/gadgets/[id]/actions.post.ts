import { z } from 'zod'
import { WORKSPACE_ID } from '../../../../shared/ids'
import { cf } from '../../../utils/cf'
import { requireMember } from '../../../utils/guards'
import { invokeGadget } from '../../../utils/gadget-runtime'
import { parseBody } from '../../../utils/validate'

const valueSchema = z.union([z.string(), z.number().finite(), z.boolean(), z.null()])
const bodySchema = z.object({
  bindingId: z.string().min(1),
  operation: z.enum(['create', 'update']),
  recordId: z.string().min(1).optional(),
  title: z.string().max(500).optional(),
  values: z.record(z.string(), valueSchema).optional(),
  version: z.number().int().positive().optional(),
})

export default defineEventHandler(async (event) => {
  const actor = await requireMember(event, WORKSPACE_ID)
  const body = parseBody(bodySchema, await readBody(event))
  return { item: await invokeGadget(cf(event).env, actor, getRouterParam(event, 'id')!, body) }
})
