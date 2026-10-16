import { z } from 'zod'
import { WORKSPACE_ID } from '../../../../shared/ids'
import { Permission } from '../../../../shared/permissions'
import { requireMember } from '../../../utils/guards'
import { cf } from '../../../utils/cf'
import { createTask } from '../../../utils/task-service'
import { parseBody } from '../../../utils/validate'

const bodySchema = z.object({
  title: z.string().trim().min(1).max(160),
  description: z.string().trim().max(12_000).default(''),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'),
  dueAt: z.string().refine(value => !Number.isNaN(Date.parse(value)), 'Invalid due date').nullable().default(null),
  assigneeId: z.string().min(8).nullable().default(null),
  channelId: z.string().min(8).nullable().default(null),
  labelIds: z.array(z.string().min(8)).max(20).default([]),
  dependencyIds: z.array(z.string().min(8)).max(100).default([]),
})

export default defineEventHandler(async (event) => {
  const boardId = getRouterParam(event, 'id')!
  const actor = await requireMember(event, WORKSPACE_ID, Permission.manageTasks)
  const body = parseBody(bodySchema, await readBody(event))
  const { env, waitUntil } = cf(event)
  return { task: await createTask(env, actor.authorization, boardId, body, waitUntil) }
})
