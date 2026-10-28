import { getServerId } from '../../../../shared/server-id'
import { z } from 'zod'
import { requireMember } from '../../../utils/guards'
import { cf } from '../../../utils/cf'
import { createTask } from '../../../utils/task-service'
import { parseBody } from '../../../utils/validate'
import { requireTaskSourceMessage } from '../../../utils/task-sources'

const bodySchema = z.object({
  title: z.string().trim().min(1).max(160),
  description: z.string().trim().max(12_000).default(''),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'),
  dueAt: z.string().refine(value => !Number.isNaN(Date.parse(value)), 'Invalid due date').nullable().default(null),
  assigneeId: z.string().min(8).nullable().default(null),
  projectId: z.string().min(8).nullable().optional(),
  environmentId: z.string().min(8).nullable().optional(),
  channelId: z.string().min(8).nullable().default(null),
  labelIds: z.array(z.string().min(8)).max(20).default([]),
  dependencyIds: z.array(z.string().min(8)).max(100).default([]),
  /** Create the task from this chat message; the creator must be able to read it. */
  sourceMessageId: z.string().min(8).max(80).optional(),
})

export default defineEventHandler(async (event) => {
  const boardId = getRouterParam(event, 'id')!
  const actor = await requireMember(event, (await getServerId(cf(event).env.DB)))
  const body = parseBody(bodySchema, await readBody(event))
  const { env, waitUntil } = cf(event)
  const { sourceMessageId, ...input } = body
  const source = sourceMessageId ? (await requireTaskSourceMessage(env, actor, sourceMessageId)).message : null
  return { task: await createTask(env, actor.authorization, boardId, { ...input, source: source && { channelId: source.channelId, messageId: source.id } }, waitUntil) }
})
