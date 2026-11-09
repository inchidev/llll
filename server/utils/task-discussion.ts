import { and, eq, isNull } from 'drizzle-orm'
import { channels, taskNumbers, tasks } from '../../drizzle/schema'
import type { AuthorizationContext } from '../../shared/authorization'
import { newId, nowIso } from '../../shared/ids'
import { Permission } from '../../shared/permissions'
import type { L4Env } from '../../workers/env'
import { fail } from './cf'
import { getDb } from './db'
import { spaceOfResource } from './space-access'
import { requireTask, taskPermissionAllowed } from './task-policy'

/**
 * The Task's discussion channel, made on first use. It is an ordinary text channel, so messages, reactions,
 * threads, files and realtime all work as in chat; the channel list leaves it out and only people who work
 * with the Task can open it.
 */
export async function ensureTaskDiscussion(env: L4Env, auth: AuthorizationContext, taskReference: string): Promise<string> {
  const db = getDb(env.DB)
  const task = await requireTask(env, taskReference, auth)
  if (!taskPermissionAllowed(auth, task, Permission.writeTasks) && !taskPermissionAllowed(auth, task, Permission.executeTasks)) fail(403, 'task_denied', 'Write tasks or Execute assigned tasks is required to prepare a discussion')
  if (task.discussionChannelId) return task.discussionChannelId

  const number = (await db.select({ number: taskNumbers.number }).from(taskNumbers)
    .where(eq(taskNumbers.taskId, task.id)).limit(1))[0]?.number
  const spaceId = await spaceOfResource(env, 'board', task.boardId)
  if (!spaceId) fail(404, 'not_found', 'Task not found')
  const id = newId()
  const created = nowIso()
  await db.insert(channels).values({
    id,
    spaceId: spaceId!,
    name: number ? `task-${number}` : 'task',
    topic: task.title,
    type: 'text',
    visibility: 'server',
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
    const current = await requireTask(env, task.id, auth)
    return current.discussionChannelId!
  }
  return id
}
