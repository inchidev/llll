import { z } from 'zod'
import { cf } from '../../utils/cf'
import { requireMember } from '../../utils/guards'
import { getServerId } from '../../../shared/server-id'
import { prepareComputePairing } from '../../utils/compute-nodes'
export default defineEventHandler(async event => {
  setHeader(event, 'Cache-Control', 'private, no-store')
  const { env } = cf(event), actor = await requireMember(event, await getServerId(env.DB))
  const input = z.object({ name: z.string().trim().min(1).max(80) }).strict().parse(await readBody(event))
  return prepareComputePairing(env, actor.authorization, input.name)
})
