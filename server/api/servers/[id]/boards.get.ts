import type { TaskBoardDTO } from '../../../../shared/types'
import { requireMember } from '../../../utils/guards'
import { cf } from '../../../utils/cf'
import { listTasks } from '../../../utils/task-service'

export default defineEventHandler(async (event): Promise<{ boards: TaskBoardDTO[] }> => {
  const serverId = getRouterParam(event, 'id')!
  const actor = await requireMember(event, serverId)
  const includeArchived = getQuery(event).archived === 'true'
  return { boards: await listTasks(cf(event).env, actor.authorization, includeArchived) }
})
