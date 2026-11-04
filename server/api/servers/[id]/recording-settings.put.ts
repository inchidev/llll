import { Permission } from '../../../../shared/permissions'
import { cf } from '../../../utils/cf'
import { requireMember } from '../../../utils/guards'
import { saveRecordingSettings } from '../../../utils/task-recordings'

export default defineEventHandler(async (event) => {
  const actor = await requireMember(event, getRouterParam(event, 'id')!, Permission.manageServer)
  return { settings: await saveRecordingSettings(cf(event).env, actor.authorization, await readBody(event)) }
})
