import type { TaskBoardDTO } from '../../../../shared/types'
import { Permission } from '../../../../shared/permissions'
import { requireMember } from '../../../utils/guards'
import { cf } from '../../../utils/cf'
import { listTasks } from '../../../utils/task-service'

export default defineEventHandler(async (event): Promise<{ boards: TaskBoardDTO[] }> => {
  const workspaceId = getRouterParam(event, 'id')!
  const actor = await requireMember(event, workspaceId, Permission.manageTasks)
  const includeArchived = getQuery(event).archived === 'true'
  return { boards: await listTasks(cf(event).env, actor.authorization, includeArchived) }
})
