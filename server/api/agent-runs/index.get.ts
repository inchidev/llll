import { z } from 'zod'
import { getServerId } from '../../../shared/server-id'
import { listOwnRuns, runListStatuses } from '../../utils/agent-run-list'
import { requireMember } from '../../utils/guards'
import { cf } from '../../utils/cf'
import { parseBody } from '../../utils/validate'

const querySchema = z.object({
  status: z.enum(runListStatuses).optional(),
  agentId: z.string().min(8).max(80).optional(),
  cursor: z.string().max(200).optional(),
})

export default defineEventHandler(async (event) => {
  setHeader(event, 'Cache-Control', 'private, no-store')
  const { env } = cf(event)
  const actor = await requireMember(event, await getServerId(env.DB))
  return listOwnRuns(env, actor, parseBody(querySchema, getQuery(event)))
})
