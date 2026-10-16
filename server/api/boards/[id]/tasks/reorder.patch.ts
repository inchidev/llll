import { and, eq, isNull } from 'drizzle-orm'
import { z } from 'zod'
import { tasks } from '../../../../../drizzle/schema'
import { nowIso, WORKSPACE_ID } from '../../../../../shared/ids'
import { Permission } from '../../../../../shared/permissions'
import { signalTasksChanged } from '../../../../../workers/task-events'
import { cf, fail } from '../../../../utils/cf'
import { getDb } from '../../../../utils/db'
import { requireMember } from '../../../../utils/guards'
import { writeAudit } from '../../../../utils/messages'
import { requireBoard, requireTask } from '../../../../utils/task-policy'
import { parseBody } from '../../../../utils/validate'

const bodySchema = z.object({
  taskId: z.string().min(8),
  status: z.enum(['backlog', 'ready', 'review', 'done', 'failed']),
  beforeTaskId: z.string().min(8).nullable().default(null),
})

export default defineEventHandler(async (event) => {
  const actor = await requireMember(event, WORKSPACE_ID, Permission.manageTasks)
  const boardId = getRouterParam(event, 'id')!
  const body = parseBody(bodySchema, await readBody(event))
  const { env, waitUntil } = cf(event)
  const db = getDb(env.DB)
  await requireBoard(env, boardId)
  const moving = await requireTask(env, body.taskId)
  if (moving.boardId !== boardId || moving.archivedAt) fail(404, 'not_found', 'Task not found on this board')
  const destination = await db.select({ id: tasks.id }).from(tasks)
    .where(and(eq(tasks.boardId, boardId), eq(tasks.status, body.status), isNull(tasks.archivedAt)))
    .orderBy(tasks.position, tasks.createdAt)
  const ordered = destination.map(row => row.id).filter(id => id !== moving.id)
  if (body.beforeTaskId) {
    const index = ordered.indexOf(body.beforeTaskId)
    if (index === -1) fail(400, 'bad_request', 'Destination task is not in the selected column')
    ordered.splice(index, 0, moving.id)
  }
  else {
    ordered.push(moving.id)
  }

  const now = nowIso()
  const updates = ordered.map((id, index) => db.update(tasks).set({
    status: body.status,
    position: (index + 1) * 1024,
    updatedAt: id === moving.id ? now : undefined,
    lastError: id === moving.id && body.status !== 'failed' ? null : undefined,
  }).where(eq(tasks.id, id)))
  await db.batch(updates as [typeof updates[number], ...Array<typeof updates[number]>])
  await writeAudit(env, {
    workspaceId: WORKSPACE_ID,
    actorId: actor.user.id,
    action: 'task.move',
    targetType: 'task',
    targetId: moving.id,
    meta: { boardId, fromStatus: moving.status, toStatus: body.status, beforeTaskId: body.beforeTaskId },
  })
  waitUntil(signalTasksChanged(env, boardId, moving.id))
  return { ok: true }
})
