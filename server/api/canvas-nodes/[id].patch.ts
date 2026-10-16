import { z } from 'zod'
import { nowIso, WORKSPACE_ID } from '../../../shared/ids'
import { Permission } from '../../../shared/permissions'
import type { CanvasNodeDTO } from '../../../shared/types'
import { cf, fail } from '../../utils/cf'
import { requireCanvasNode } from '../../utils/data-resources'
import { requireMember } from '../../utils/guards'
import { writeAudit } from '../../utils/messages'
import { parseBody } from '../../utils/validate'

const bodySchema = z.object({
  content: z.string().max(20_000).optional(),
  x: z.number().finite().min(-10_000).max(10_000).optional(),
  y: z.number().finite().min(-10_000).max(10_000).optional(),
  width: z.number().finite().min(120).max(1200).optional(),
  height: z.number().finite().min(72).max(1200).optional(),
  color: z.enum(['neutral', 'orange', 'blue', 'green', 'red']).optional(),
  version: z.number().int().positive(),
}).refine(body => Object.keys(body).some(key => key !== 'version'), 'No changes')

export default defineEventHandler(async (event) => {
  const actor = await requireMember(event, WORKSPACE_ID, Permission.manageDatabases)
  const id = getRouterParam(event, 'id')!
  const body = parseBody(bodySchema, await readBody(event))
  const { env } = cf(event)
  const node = await requireCanvasNode(env, id)
  if (node.version !== body.version) fail(409, 'stale_canvas_item', 'This canvas item changed elsewhere. Reload and try again.')
  const assignments = ['updated_at = ?', 'version = version + 1']
  const values: Array<string | number> = [nowIso()]
  for (const key of ['content', 'x', 'y', 'width', 'height', 'color'] as const) {
    const value = body[key]
    if (value === undefined) continue
    assignments.push(`${key} = ?`)
    values.push(value)
  }
  const updated = await env.DB.prepare(
    `UPDATE canvas_nodes SET ${assignments.join(', ')} WHERE id = ? AND version = ?
     RETURNING id, canvas_id as canvasId, kind, content, x, y, width, height, color, version,
     created_by as createdBy, created_at as createdAt, updated_at as updatedAt`,
  ).bind(...values, id, body.version).first<CanvasNodeDTO>()
  if (!updated) fail(409, 'stale_canvas_item', 'This canvas item changed elsewhere. Reload and try again.')
  await writeAudit(env, { workspaceId: WORKSPACE_ID, actorId: actor.user.id, action: 'canvas_node.update', targetType: 'canvas_node', targetId: id, meta: { canvasId: node.canvasId, fields: Object.keys(body).filter(key => key !== 'version') } })
  return { node: updated }
})
