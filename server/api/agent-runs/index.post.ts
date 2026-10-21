import { createAgentRun } from '../../utils/agent-run-service'
import { runRequestSchema } from '../../../shared/agent-execution'
import { requireMember } from '../../utils/guards'
import { Permission } from '../../../shared/permissions'
import { getServerId } from '../../../shared/server-id'
import { cf } from '../../utils/cf'
import { parseBody } from '../../utils/validate'

export default defineEventHandler(async (event) => {
  const { env } = cf(event)
  const actor = await requireMember(event, await getServerId(env.DB), Permission.useAgents)
  const run = await createAgentRun(env, actor.authorization, parseBody(runRequestSchema, await readBody(event)))
  return { run: { id: run.id, status: run.status, channelId: run.channelId } }
})
