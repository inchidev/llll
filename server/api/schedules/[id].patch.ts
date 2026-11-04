import { dismissSchedule, pauseSchedule, resumeSchedule, updateSchedule } from '../../utils/schedule-service'
import { schedulePatchSchema } from '../../../shared/schedules'
import { requireMember } from '../../utils/guards'
import { Permission } from '../../../shared/permissions'
import { getServerId } from '../../../shared/server-id'
import { cf } from '../../utils/cf'
import { parseBody } from '../../utils/validate'

export default defineEventHandler(async event => {
  const { env } = cf(event)
  const actor = await requireMember(event, await getServerId(env.DB), Permission.manageSchedules)
  const id = getRouterParam(event, 'id')!
  const { action, ...edit } = parseBody(schedulePatchSchema, await readBody(event))
  if (action === 'edit') return { schedule: await updateSchedule(env, actor.authorization, id, edit) }
  if (action === 'dismiss') { await dismissSchedule(env, actor.authorization, id); return { ok: true } }
  return { schedule: await (action === 'pause' ? pauseSchedule : resumeSchedule)(env, actor.authorization, id) }
})
