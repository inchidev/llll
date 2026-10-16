import { WORKSPACE_ID } from '../../../shared/ids'
import { Permission } from '../../../shared/permissions'
import { cf, fail } from '../../utils/cf'
import { requireMember } from '../../utils/guards'
import { getTask } from '../../utils/task-service'

export default defineEventHandler(async (event) => {
  const actor = await requireMember(event, WORKSPACE_ID, Permission.manageTasks)
  const task = await getTask(cf(event).env, actor.authorization, getRouterParam(event, 'id')!)
  if (!task) fail(404, 'not_found', 'Task not found')
  return { task }
})
