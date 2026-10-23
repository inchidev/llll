import { z } from 'zod'
import { createAgentRun, findAgentRun } from '../../../utils/agent-run-service'
import { cf, fail } from '../../../utils/cf'
import { requireChannelAccess } from '../../../utils/guards'
import { parseBody } from '../../../utils/validate'

export default defineEventHandler(async event => {
  const { env } = cf(event)
  const run = await findAgentRun(env, getRouterParam(event, 'id')!)
  if (!run) fail(404, 'not_found', 'Run not found')
  const actor = await requireChannelAccess(event, run.channelId)
  if (!['failed', 'cancelled'].includes(run.status)) fail(409, 'run_active', 'Only a stopped run can be retried')
  const { requestId } = parseBody(z.object({ requestId: z.string().uuid() }), await readBody(event))
  return { run: await createAgentRun(env, actor.authorization, {
    agentId: run.agentId, channelId: run.channelId, prompt: run.prompt, idempotencyKey: requestId,
    sourceMessageId: run.sourceMessageId ?? undefined, taskId: run.taskId ?? undefined,
    environmentId: run.environmentJson ? JSON.parse(run.environmentJson).id : undefined,
  }) }
})
