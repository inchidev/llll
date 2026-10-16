import { WORKSPACE_ID } from '../../../shared/ids'
import { Permission } from '../../../shared/permissions'
import { cf, fail } from '../../utils/cf'
import { requireMember } from '../../utils/guards'
import { writeAudit } from '../../utils/messages'

export default defineEventHandler(async (event) => {
  const actor = await requireMember(event, WORKSPACE_ID, Permission.manageDatabases)
  const id = getRouterParam(event, 'id')!
  const { env } = cf(event)
  const edge = await env.DB.prepare(
    'SELECT id, canvas_id as canvasId, from_node_id as fromNodeId, to_node_id as toNodeId FROM canvas_edges WHERE id = ?',
  ).bind(id).first<{ id: string; canvasId: string; fromNodeId: string; toNodeId: string }>()
  if (!edge) fail(404, 'not_found', 'Canvas connection not found')
  await env.DB.prepare('DELETE FROM canvas_edges WHERE id = ?').bind(id).run()
  await writeAudit(env, { workspaceId: WORKSPACE_ID, actorId: actor.user.id, action: 'canvas_edge.delete', targetType: 'canvas_edge', targetId: id, meta: { canvasId: edge.canvasId } })
  return { ok: true }
})
