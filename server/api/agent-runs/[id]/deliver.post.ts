import { findAgentRun, runAuthorization } from '../../../utils/agent-run-service'
import { requireChannelAccess } from '../../../utils/guards'
import { cf, fail } from '../../../utils/cf'
import { asRpc } from '../../../../workers/env'
export default defineEventHandler(async event => {
  const { env } = cf(event)
  const run = await findAgentRun(env, getRouterParam(event, 'id')!)
  if (!run || !['completed', 'failed'].includes(run.status)) fail(409, 'delivery_unavailable', 'Finish the Run before retrying delivery')
  const actor = await requireChannelAccess(event, run.channelId)
  if (actor.user.id !== run.initiatedBy) fail(403, 'forbidden', 'Only the initiating member can retry delivery')
  await runAuthorization(env, run)
  await env.DB.prepare("UPDATE agent_run_deliveries SET task_status=CASE WHEN task_status='blocked' THEN 'pending' ELSE task_status END,report_status=CASE WHEN report_status='blocked' THEN 'pending' ELSE report_status END,attempts=0 WHERE run_id=?").bind(run.id).run()
  if (!env.AGENT_RUN_DO) fail(503, 'unavailable', 'Run coordinator is unavailable')
  await asRpc<{ wake: (id: string) => Promise<void> }>(env.AGENT_RUN_DO.getByName(`run:${run.id}`)).wake(run.id)
  return { ok: true }
})
