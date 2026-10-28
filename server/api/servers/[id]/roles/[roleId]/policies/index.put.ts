import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { roles } from '../../../../../../../drizzle/schema'
import { Permission } from '../../../../../../../shared/permissions'
import { cf, fail } from '../../../../../../utils/cf'
import { getDb } from '../../../../../../utils/db'
import { requireMember } from '../../../../../../utils/guards'
import { writeAudit } from '../../../../../../utils/messages'
import { assertGrantScope, assertRoleManageable } from '../../../../../../utils/role-policy'
import { parseBody } from '../../../../../../utils/validate'
import { signalMembersChanged } from '../../../../../../../workers/member-events'
import { revalidateLiveRooms } from '../../../../../../utils/live'

const schema = z.object({ policyIds: z.array(z.string().min(1).max(200)).max(200) }).strict()
export default defineEventHandler(async (event) => {
  const serverId = getRouterParam(event, 'id')!, roleId = getRouterParam(event, 'roleId')!
  const actor = await requireMember(event, serverId, Permission.manageRoles)
  const { env, waitUntil } = cf(event)
  const role = (await getDb(env.DB).select().from(roles).where(eq(roles.id, roleId)).limit(1))[0]
  if (!role) fail(404, 'not_found', 'Role not found')
  if (role.isSystem) fail(403, 'forbidden', 'System roles cannot be changed')
  assertRoleManageable(actor, role)
  const { policyIds } = parseBody(schema, await readBody(event))
  if (new Set(policyIds).size !== policyIds.length) fail(400, 'duplicate_policy', 'Duplicate policy')
  const policies = await Promise.all(policyIds.map(id => env.DB.prepare('SELECT permissions_bitmask AS permissions FROM project_policies WHERE id=?').bind(id).first<{ permissions: number }>()))
  if (policies.some(policy => !policy)) fail(404, 'not_found', 'Policy not found')
  for (const policy of policies) assertGrantScope(actor, policy!.permissions)
  await env.DB.batch([
    env.DB.prepare('DELETE FROM role_policies WHERE role_id=?').bind(roleId),
    ...policyIds.map(id => env.DB.prepare('INSERT INTO role_policies(role_id,policy_id) VALUES (?,?)').bind(roleId, id)),
  ])
  await writeAudit(env, { serverId, actorId: actor.user.id, action: 'role.policies.update', targetType: 'role', targetId: roleId, meta: { policyIds } })
  waitUntil(signalMembersChanged(env, serverId))
  waitUntil(revalidateLiveRooms(env))
  return { policyIds }
})
