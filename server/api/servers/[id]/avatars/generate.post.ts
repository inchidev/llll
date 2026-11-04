import { z } from 'zod'
import { generateAvatar } from '../../../../utils/ai-functions'
import { cf, fail, originOk } from '../../../../utils/cf'
import { requireMember } from '../../../../utils/guards'
import { parseBody } from '../../../../utils/validate'

/** Draws a picture for preview only; nothing is stored until the member uploads it as an avatar. */
export default defineEventHandler(async event => {
  setHeader(event, 'Cache-Control', 'no-store')
  if (!await originOk(event)) fail(403, 'origin_denied', 'Generate avatars from this Server')
  const member = await requireMember(event, getRouterParam(event, 'id')!)
  const input = parseBody(z.object({ name: z.string().trim().min(1).max(80), description: z.string().trim().max(1000).optional(), references: z.array(z.string().max(2_800_000)).max(3).optional(), l4Style: z.boolean().optional() }).strict(), await readBody(event))
  return { image: await generateAvatar(cf(event).env, member.authorization, input) }
})
