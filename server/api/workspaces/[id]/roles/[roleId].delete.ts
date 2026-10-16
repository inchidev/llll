import { and, eq } from 'drizzle-orm'
import { roles, users } from '../../../../../drizzle/schema'
import { nowIso } from '../../../../../shared/ids'
import { Permission } from '../../../../../shared/permissions'
import { requireMember } from '../../../../utils/guards'
import { cf, fail } from '../../../../utils/cf'
import { getDb } from '../../../../utils/db'
import { writeAudit } from '../../../../utils/messages'

export default defineEventHandler(async (event) => {
  const workspaceId = getRouterParam(event, 'id')!
  const roleId = getRouterParam(event, 'roleId')!
  const actor = await requireMember(event, workspaceId, Permission.manageRoles)
  const { env } = cf(event)
  const db = getDb(env.DB)
  const role = (await db.select().from(roles).where(eq(roles.id, roleId)).limit(1))[0]
  if (!role) fail(404, 'not_found', 'Role not found')
  if (role.isSystem) fail(403, 'forbidden', 'System roles cannot be deleted')
  const memberRole = (await db.select().from(roles).where(eq(roles.key, 'member')).limit(1))[0]
  if (!memberRole) fail(500, 'internal', 'Member role missing')
  const updatedAt = nowIso()
  await db.batch([
    db.update(users).set({ roleId: memberRole.id, updatedAt })
      .where(and(eq(users.roleId, role.id), eq(users.status, 'active'))),
    db.delete(roles).where(eq(roles.id, role.id)),
  ])
  await writeAudit(env, {
    workspaceId,
    actorId: actor.user.id,
    action: 'role.delete',
    targetType: 'role',
    targetId: role.id,
    meta: { name: role.name },
  })
  return { ok: true }
})
