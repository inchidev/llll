import { listScheduleOccurrences } from '../../../utils/schedule-service'
import { requireMember } from '../../../utils/guards'
import { Permission } from '../../../../shared/permissions'
import { getServerId } from '../../../../shared/server-id'
import { cf } from '../../../utils/cf'

export default defineEventHandler(async event => {
  const { env } = cf(event)
  const actor = await requireMember(event, await getServerId(env.DB), Permission.manageSchedules)
  return { occurrences: await listScheduleOccurrences(env, actor.authorization, getRouterParam(event, 'id')!) }
})
