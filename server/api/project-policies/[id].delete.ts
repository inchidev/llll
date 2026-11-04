import { Permission } from '../../../shared/permissions'
import { getServerId } from '../../../shared/server-id'
import { signalMembersChanged } from '../../../workers/member-events'
import { cf, fail } from '../../utils/cf'
import { requireMember } from '../../utils/guards'
import { revalidateLiveRooms } from '../../utils/live'
import { writeAudit } from '../../utils/messages'

export default defineEventHandler(async (event) => {
  const { env, waitUntil } = cf(event)
  const serverId = await getServerId(env.DB)
  const actor = await requireMember(event, serverId, Permission.manageRoles)
  if (!actor.isOwner) fail(403, 'forbidden', 'Only the owner can delete policies')
  const id = getRouterParam(event, 'id')!
  if (id.startsWith('server-policy-')) fail(403, 'forbidden', 'System policies cannot be deleted')
  const existing = await env.DB.prepare('SELECT id FROM project_policies WHERE id=?').bind(id).first()
  if (!existing) fail(404, 'not_found', 'Policy not found')
  await env.DB.prepare('DELETE FROM project_policies WHERE id=?').bind(id).run()
  await writeAudit(env, { serverId, actorId: actor.user.id, action: 'policy.delete', targetType: 'policy', targetId: id })
  waitUntil(signalMembersChanged(env, serverId))
  waitUntil(revalidateLiveRooms(env))
  return { ok: true }
})
