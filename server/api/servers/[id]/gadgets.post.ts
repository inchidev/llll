import { z } from 'zod'
import type { GadgetDetailDTO, GadgetSpec } from '../../../../shared/gadgets'
import { cf, fail } from '../../../utils/cf'
import { canManageGadgets, createGadget } from '../../../utils/gadget-catalog'
import { composeGadgetSpec } from '../../../utils/gadget-composer'
import { requireMember } from '../../../utils/guards'
import { parseBody } from '../../../utils/validate'

const bodySchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500).default(''),
  prompt: z.string().trim().min(1).max(2000).optional(),
  spec: z.unknown().optional(),
  roleIds: z.array(z.string().min(1)).max(64).default([]),
})

export default defineEventHandler(async (event): Promise<{ gadget: GadgetDetailDTO }> => {
  const serverId = getRouterParam(event, 'id')!
  const actor = await requireMember(event, serverId)
  if (!canManageGadgets(actor)) fail(403, 'forbidden', 'Managing Apps also requires Manage data')
  const body = parseBody(bodySchema, await readBody(event))
  const env = cf(event).env
  const spec = body.prompt ? await composeGadgetSpec(env, actor.authorization, body.prompt) : body.spec as GadgetSpec | undefined
  const currentActor = body.prompt ? await requireMember(event, serverId) : actor
  return { gadget: await createGadget(env, currentActor, { name: body.name, description: body.description, spec, roleIds: body.roleIds }) }
})
