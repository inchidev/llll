import { z } from 'zod'
import { WORKSPACE_ID } from '../../../shared/ids'
import { Permission } from '../../../shared/permissions'
import { cf } from '../../utils/cf'
import { requireMember } from '../../utils/guards'
import { updateTask } from '../../utils/task-service'
import { parseBody } from '../../utils/validate'

const bodySchema = z.object({
  title: z.string().trim().min(1).max(160).optional(),
  description: z.string().trim().max(12_000).optional(),
  status: z.enum(['backlog', 'ready', 'review', 'done', 'failed']).optional(),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
  dueAt: z.string().refine(value => !Number.isNaN(Date.parse(value)), 'Invalid due date').nullable().optional(),
  position: z.number().int().min(0).optional(),
  boardId: z.string().min(8).optional(),
  assigneeId: z.string().min(8).nullable().optional(),
  channelId: z.string().min(8).nullable().optional(),
  archived: z.boolean().optional(),
  labelIds: z.array(z.string().min(8)).max(20).optional(),
  dependencyIds: z.array(z.string().min(8)).max(100).optional(),
}).refine(body => Object.keys(body).length > 0, 'No changes')

export default defineEventHandler(async (event) => {
  const actor = await requireMember(event, WORKSPACE_ID, Permission.manageTasks)
  const id = getRouterParam(event, 'id')!
  const body = parseBody(bodySchema, await readBody(event))
  const { env, waitUntil } = cf(event)
  return { task: await updateTask(env, actor.authorization, id, body, waitUntil) }
})
