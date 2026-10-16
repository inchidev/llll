import { and, eq, isNull } from 'drizzle-orm'
import { channels, taskNumbers, tasks } from '../../../../drizzle/schema'
import { newId, nowIso, WORKSPACE_ID } from '../../../../shared/ids'
import { Permission } from '../../../../shared/permissions'
import { cf } from '../../../utils/cf'
import { getDb } from '../../../utils/db'
import { requireMember } from '../../../utils/guards'
import { requireTask } from '../../../utils/task-policy'

/**
 * Returns the task's discussion channel, creating it on first use. It is an
 * ordinary text channel, so messages, reactions, threads, files, and realtime all
 * work as in chat; the channel list leaves it out and only task managers can open it.
 */
export default defineEventHandler(async (event) => {
  await requireMember(event, WORKSPACE_ID, Permission.manageTasks)
  const { env } = cf(event)
  const db = getDb(env.DB)
  const task = await requireTask(env, getRouterParam(event, 'id')!)
  if (task.discussionChannelId) return { channelId: task.discussionChannelId }

  const number = (await db.select({ number: taskNumbers.number }).from(taskNumbers)
    .where(eq(taskNumbers.taskId, task.id)).limit(1))[0]?.number
  const id = newId()
  const created = nowIso()
  await db.insert(channels).values({
    id,
    name: number ? `task-${number}` : 'task',
    topic: task.title,
    type: 'text',
    visibility: 'workspace',
    categoryId: null,
    position: 0,
    liveMeetingId: null,
    parentId: null,
    parentMessageId: null,
    createdAt: created,
    updatedAt: created,
  })
  // Two people opening the task at once: the first link wins, the spare channel is removed.
  const linked = await db.update(tasks).set({ discussionChannelId: id })
    .where(and(eq(tasks.id, task.id), isNull(tasks.discussionChannelId)))
  if (!linked.meta.changes) {
    await db.delete(channels).where(eq(channels.id, id))
    const current = await requireTask(env, task.id)
    return { channelId: current.discussionChannelId }
  }
  return { channelId: id }
})
