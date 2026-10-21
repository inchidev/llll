import { findAgentRun } from '../../../utils/agent-run-service'
import { requireRunFiles } from '../../../utils/agent-files'
import { requireChannelAccess } from '../../../utils/guards'
import { cf, fail } from '../../../utils/cf'

export default defineEventHandler(async (event) => {
  const { env } = cf(event)
  const run = await findAgentRun(env, getRouterParam(event, 'id')!)
  if (!run) fail(404, 'not_found', 'Run not found')
  const actor = await requireChannelAccess(event, run.channelId)
  await requireRunFiles(env, actor.authorization, run)
  const object = run.filesKey ? await env.FILES?.get(run.filesKey) : null
  if (!object || object.size > 2000000) fail(404, 'not_found', 'Working files are unavailable')
  setHeader(event, 'Content-Type', 'application/json')
  setHeader(event, 'Content-Disposition', `attachment; filename="run-${run.id}-files.json"`)
  setHeader(event, 'Cache-Control', 'no-store')
  return object.body
})
