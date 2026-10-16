import { z } from 'zod'
import { newId, nowIso, WORKSPACE_ID } from '../../../../shared/ids'
import { Permission } from '../../../../shared/permissions'
import { cf } from '../../../utils/cf'
import { loadCanvasNode, requireCanvas } from '../../../utils/data-resources'
import { requireMember } from '../../../utils/guards'
import { writeAudit } from '../../../utils/messages'
import { parseBody } from '../../../utils/validate'

const bodySchema = z.object({
  kind: z.enum(['note', 'text']).default('note'),
  content: z.string().max(20_000).default(''),
  x: z.number().finite().min(-10_000).max(10_000),
  y: z.number().finite().min(-10_000).max(10_000),
  color: z.enum(['neutral', 'orange', 'blue', 'green', 'red']).default('neutral'),
})

export default defineEventHandler(async (event) => {
  const actor = await requireMember(event, WORKSPACE_ID, Permission.manageDatabases)
  const canvasId = getRouterParam(event, 'id')!
  const body = parseBody(bodySchema, await readBody(event))
  const { env } = cf(event)
  await requireCanvas(env, canvasId)
  const id = newId()
  const now = nowIso()
  await env.DB.prepare(
    `INSERT INTO canvas_nodes
     (id, canvas_id, kind, content, x, y, width, height, color, version, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 240, 144, ?, 1, ?, ?, ?)`,
  ).bind(id, canvasId, body.kind, body.content, body.x, body.y, body.color, actor.user.id, now, now).run()
  await writeAudit(env, { workspaceId: WORKSPACE_ID, actorId: actor.user.id, action: 'canvas_node.create', targetType: 'canvas_node', targetId: id, meta: { canvasId, kind: body.kind } })
  return { node: await loadCanvasNode(env, id) }
})
