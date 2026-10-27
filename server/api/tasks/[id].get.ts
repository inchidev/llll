import { getServerId } from '../../../shared/server-id'
import { cf, fail } from '../../utils/cf'
import { requireMember } from '../../utils/guards'
import { getTask } from '../../utils/task-service'

export default defineEventHandler(async (event) => {
  const actor = await requireMember(event, (await getServerId(cf(event).env.DB)))
  const task = await getTask(cf(event).env, actor.authorization, getRouterParam(event, 'id')!)
  if (!task) fail(404, 'not_found', 'Task not found')
  const latest = await cf(event).env.DB.prepare('SELECT id FROM agent_runs WHERE task_id=? AND initiated_by=? ORDER BY created_at DESC,id DESC LIMIT 1').bind(task.id, actor.user.id).first<{ id: string }>()
  return { task: { ...task, ...(latest && task.resultDetails?.startsWith('[Open private Run](') ? { resultDetails: `[Open private Run](/runs/${latest.id})` } : {}) } }
})
