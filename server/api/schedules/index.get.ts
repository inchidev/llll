import { listSchedules } from '../../utils/schedule-service'
import { piConfigured } from '../../utils/agent-run-service'
import { scheduleListQuerySchema } from '../../../shared/schedules'
import { requireMember } from '../../utils/guards'
import { Permission } from '../../../shared/permissions'
import { getServerId } from '../../../shared/server-id'
import { cf } from '../../utils/cf'
import { parseBody } from '../../utils/validate'

export default defineEventHandler(async event => {
  const { env } = cf(event)
  const actor = await requireMember(event, await getServerId(env.DB), Permission.manageSchedules)
  const page = await listSchedules(env, actor.authorization, parseBody(scheduleListQuerySchema, getQuery(event)))
  return { ...page, workAvailable: await piConfigured(env) }
})
