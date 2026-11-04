import { createSchedule } from '../../utils/schedule-service'
import { scheduleRequestSchema } from '../../../shared/schedules'
import { requireMember } from '../../utils/guards'
import { Permission } from '../../../shared/permissions'
import { getServerId } from '../../../shared/server-id'
import { cf } from '../../utils/cf'
import { parseBody } from '../../utils/validate'

export default defineEventHandler(async event => {
  const { env } = cf(event)
  const actor = await requireMember(event, await getServerId(env.DB), Permission.manageSchedules)
  return { schedule: await createSchedule(env, actor.authorization, parseBody(scheduleRequestSchema, await readBody(event))) }
})
