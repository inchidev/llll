import { z } from 'zod'
import { newId, nowIso, WORKSPACE_ID } from '../../../../shared/ids'
import { Permission } from '../../../../shared/permissions'
import { cf, fail } from '../../../utils/cf'
import { requireCanvas, requireCanvasNode } from '../../../utils/data-resources'
import { requireMember } from '../../../utils/guards'
import { writeAudit } from '../../../utils/messages'
import { parseBody } from '../../../utils/validate'

const bodySchema = z.object({ fromNodeId: z.string().min(8), toNodeId: z.string().min(8) })
  .refine(body => body.fromNodeId !== body.toNodeId, 'Choose two different canvas items')

export default defineEventHandler(async (event) => {
  const actor = await requireMember(event, WORKSPACE_ID, Permission.manageDatabases)
  const canvasId = getRouterParam(event, 'id')!
  const body = parseBody(bodySchema, await readBody(event))
  const { env } = cf(event)
  await requireCanvas(env, canvasId)
  const [from, to] = await Promise.all([requireCanvasNode(env, body.fromNodeId), requireCanvasNode(env, body.toNodeId)])
  if (from.canvasId !== canvasId || to.canvasId !== canvasId) fail(400, 'bad_request', 'Canvas items must belong to this canvas')
  const duplicate = await env.DB.prepare(
    `SELECT id FROM canvas_edges WHERE canvas_id = ? AND
     ((from_node_id = ? AND to_node_id = ?) OR (from_node_id = ? AND to_node_id = ?)) LIMIT 1`,
  ).bind(canvasId, from.id, to.id, to.id, from.id).first()
  if (duplicate) fail(409, 'duplicate_edge', 'These canvas items are already connected')
  const id = newId()
  const createdAt = nowIso()
  await env.DB.prepare(
    'INSERT INTO canvas_edges (id, canvas_id, from_node_id, to_node_id, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).bind(id, canvasId, from.id, to.id, actor.user.id, createdAt).run()
  await writeAudit(env, { workspaceId: WORKSPACE_ID, actorId: actor.user.id, action: 'canvas_edge.create', targetType: 'canvas_edge', targetId: id, meta: { canvasId, fromNodeId: from.id, toNodeId: to.id } })
  return { edge: { id, canvasId, fromNodeId: from.id, toNodeId: to.id, createdBy: actor.user.id, createdAt } }
})
