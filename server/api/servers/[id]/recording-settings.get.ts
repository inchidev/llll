import { Permission } from '../../../../shared/permissions'
import { cf } from '../../../utils/cf'
import { requireMember } from '../../../utils/guards'
import { readRecordingSettings } from '../../../utils/task-recordings'

export default defineEventHandler(async (event) => {
  await requireMember(event, getRouterParam(event, 'id')!, Permission.manageServer)
  return { settings: await readRecordingSettings(cf(event).env) }
})
