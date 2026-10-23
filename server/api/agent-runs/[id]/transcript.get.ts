import { fileStorage } from '../../../../shared/file-storage'
import { requireRunFiles } from '../../../utils/agent-files'
import { getTask } from '../../../utils/task-service'
import { findAgentRun } from '../../../utils/agent-run-service'
import { requireChannelAccess } from '../../../utils/guards'
import { cf, fail } from '../../../utils/cf'

export default defineEventHandler(async event => {
  const { env } = cf(event)
  const run = await findAgentRun(env, getRouterParam(event, 'id')!)
  if (!run) fail(404, 'not_found', 'Run not found')
  const actor = await requireChannelAccess(event, run.channelId)
  if (run.taskId) await getTask(env, actor.authorization, run.taskId)
  if (run.environmentJson) await requireRunFiles(env, actor.authorization, run)
  const object = await fileStorage(env).get(`agent-sessions/${run.sessionId}/${run.id}.jsonl`)
  if (!object) fail(404, 'not_found', 'No transcript was archived for this run')
  setHeader(event, 'Content-Type', 'application/x-ndjson')
  setHeader(event, 'Content-Disposition', `attachment; filename="run-${run.id}.jsonl"`)
  setHeader(event, 'Cache-Control', 'private, no-store')
  return object.body
})
