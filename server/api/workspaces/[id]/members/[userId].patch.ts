import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { roles, users } from '../../../../../drizzle/schema'
import { nowIso } from '../../../../../shared/ids'
import { Permission } from '../../../../../shared/permissions'
import { requireMember } from '../../../../utils/guards'
import { cf, fail } from '../../../../utils/cf'
import { getDb } from '../../../../utils/db'
import { writeAudit } from '../../../../utils/messages'
import { assertRoleAssignable } from '../../../../utils/role-policy'
import { parseBody } from '../../../../utils/validate'
import { signalMembersChanged } from '../../../../../workers/member-events'

const bodySchema = z.object({ roleId: z.string().min(8) })

export default defineEventHandler(async (event) => {
  const workspaceId = getRouterParam(event, 'id')!
  const userId = getRouterParam(event, 'userId')!
  const actor = await requireMember(event, workspaceId, Permission.manageRoles)
  if (userId === actor.ownerId) fail(403, 'forbidden', 'Owner role cannot be changed')
  const body = parseBody(bodySchema, await readBody(event))
  const { env, waitUntil } = cf(event)
  const db = getDb(env.DB)
  const [target, role] = await Promise.all([
    db.select({ id: users.id }).from(users).where(and(eq(users.id, userId), eq(users.status, 'active'))).limit(1),
    db.select().from(roles).where(eq(roles.id, body.roleId)).limit(1),
  ])
  if (!target[0]) fail(404, 'not_found', 'Member not found')
  if (!role[0]) fail(404, 'not_found', 'Role not found')
  assertRoleAssignable(actor, role[0])
  await db.update(users).set({ roleId: role[0].id, updatedAt: nowIso() }).where(eq(users.id, userId))
  await writeAudit(env, {
    workspaceId,
    actorId: actor.user.id,
    action: 'member.role.update',
    targetType: 'user',
    targetId: userId,
    meta: { roleId: role[0].id, roleName: role[0].name },
  })
  waitUntil(signalMembersChanged(env, workspaceId))
  return { ok: true }
})
