import { z } from 'zod'
import { cf, fail } from '../../../utils/cf'
import { requireChannelAccess } from '../../../utils/guards'
import { findAgentRun } from '../../../utils/agent-run-service'
import { decideFactoryAction } from '../../../utils/factory-actions'
export default defineEventHandler(async event => {
  setHeader(event, 'Cache-Control', 'private, no-store')
  const { env } = cf(event), run = await findAgentRun(env, getRouterParam(event, 'id')!)
  if (!run) fail(404, 'not_found', 'Run not found')
  const actor = await requireChannelAccess(event, run.channelId)
  const input = z.object({ id: z.string().uuid(), digest: z.string().regex(/^[a-f0-9]{64}$/u), decision: z.enum(['approve','reject']) }).strict().parse(await readBody(event))
  return { action: await decideFactoryAction(env, run.id, actor.user.id, input) }
})
