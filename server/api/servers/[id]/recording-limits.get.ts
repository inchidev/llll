import { cf } from '../../../utils/cf'
import { requireMember } from '../../../utils/guards'
import { recordingLimits } from '../../../utils/task-recordings'

export default defineEventHandler(async (event) => {
  await requireMember(event, getRouterParam(event, 'id')!)
  return { limits: await recordingLimits(cf(event).env) }
})
