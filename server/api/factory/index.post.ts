import { z } from 'zod'
import { cf } from '../../utils/cf'
import { getServerId } from '../../../shared/server-id'
import { requireMember } from '../../utils/guards'
import { configureCloudflareFactory } from '../../utils/factory-setup'
import { parseBody } from '../../utils/validate'
export default defineEventHandler(async event => {
  setHeader(event, 'Cache-Control', 'private, no-store')
  const { env } = cf(event), actor = await requireMember(event, await getServerId(env.DB))
  const input = parseBody(z.object({ enabled: z.boolean(), acknowledgeCosts: z.literal(true) }).strict(), await readBody(event))
  return configureCloudflareFactory(env, actor.authorization, input.enabled)
})
