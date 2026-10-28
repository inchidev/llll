import { parseResourceAccess } from '../../../../../shared/resource-access'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { roles } from '../../../../../drizzle/schema'
import { nowIso } from '../../../../../shared/ids'
import { Permission } from '../../../../../shared/permissions'
import { requireMember } from '../../../../utils/guards'
import { cf, fail } from '../../../../utils/cf'
import { getDb } from '../../../../utils/db'
import { writeAudit } from '../../../../utils/messages'
import { assertGrantScope, assertResourceGrantScope, assertRoleManageable, toRoleDto } from '../../../../utils/role-policy'
import { signalMembersChanged } from '../../../../../workers/member-events'
import { revalidateLiveRooms } from '../../../../utils/live'
import { parseBody } from '../../../../utils/validate'

const bodySchema = z.object({
  name: z.string().trim().min(1).max(40).optional(),
  mentionable: z.boolean().optional(),
}).strict().refine(body => body.name !== undefined || body.mentionable !== undefined, 'No role changes supplied')

export default defineEventHandler(async (event) => {
  const serverId = getRouterParam(event, 'id')!
  const roleId = getRouterParam(event, 'roleId')!
  const actor = await requireMember(event, serverId, Permission.manageRoles)
  const body = parseBody(bodySchema, await readBody(event))
  const { env, waitUntil } = cf(event)
  const db = getDb(env.DB)
  const role = (await db.select().from(roles).where(eq(roles.id, roleId)).limit(1))[0]
  if (!role) fail(404, 'not_found', 'Role not found')
  // A built-in Role keeps its name; like its policies, only the Owner decides who may mention it.
  if (role.isSystem && (body.name !== undefined || !actor.isOwner)) fail(403, 'forbidden', 'System roles cannot be changed')
  assertRoleManageable(actor, role)
  const permissions = role.permissionsBitmask
  assertGrantScope(actor, permissions)
  assertResourceGrantScope(actor, parseResourceAccess(role.resourceAccessJson))
  if (body.name !== undefined) {
    const existing = await db.select({ id: roles.id, name: roles.name }).from(roles)
    if (existing.some(item => item.id !== role.id && item.name.toLocaleLowerCase() === body.name!.toLocaleLowerCase())) {
      fail(409, 'conflict', 'A role with this name already exists')
    }
  }
  const updated = {
    ...role,
    name: body.name ?? role.name,
    mentionable: body.mentionable ?? role.mentionable,
    permissionsBitmask: permissions,
    resourceAccessJson: role.resourceAccessJson,
    updatedAt: nowIso(),
  }
  await db.update(roles).set({
    name: updated.name,
    mentionable: updated.mentionable,
    updatedAt: updated.updatedAt,
  }).where(eq(roles.id, role.id))
  await writeAudit(env, {
    serverId,
    actorId: actor.user.id,
    action: 'role.update',
    targetType: 'role',
    targetId: role.id,
    meta: { name: updated.name, permissions: updated.permissionsBitmask, mentionable: updated.mentionable },
  })
  waitUntil(signalMembersChanged(env, serverId))
  waitUntil(revalidateLiveRooms(env))
  return { role: toRoleDto(updated, serverId) }
})
