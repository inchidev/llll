import { WORKSPACE_ID } from '../../../shared/ids'
import { Permission } from '../../../shared/permissions'
import { cf } from '../../utils/cf'
import { requireCanvasNode } from '../../utils/data-resources'
import { requireMember } from '../../utils/guards'
import { writeAudit } from '../../utils/messages'

export default defineEventHandler(async (event) => {
  const actor = await requireMember(event, WORKSPACE_ID, Permission.manageDatabases)
  const id = getRouterParam(event, 'id')!
  const { env } = cf(event)
  const node = await requireCanvasNode(env, id)
  await env.DB.prepare('DELETE FROM canvas_nodes WHERE id = ?').bind(id).run()
  await writeAudit(env, { workspaceId: WORKSPACE_ID, actorId: actor.user.id, action: 'canvas_node.delete', targetType: 'canvas_node', targetId: id, meta: { canvasId: node.canvasId } })
  return { ok: true }
})
