import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { roles } from '../../../../../drizzle/schema'
import { nowIso } from '../../../../../shared/ids'
import { ALL_PERMISSIONS, Permission } from '../../../../../shared/permissions'
import { requireMember } from '../../../../utils/guards'
import { cf, fail } from '../../../../utils/cf'
import { getDb } from '../../../../utils/db'
import { writeAudit } from '../../../../utils/messages'
import { assertGrantScope, toRoleDto } from '../../../../utils/role-policy'
import { parseBody } from '../../../../utils/validate'

const bodySchema = z.object({
  name: z.string().trim().min(1).max(40).optional(),
  permissions: z.number().int().min(0).max(ALL_PERMISSIONS).optional(),
}).refine(body => body.name !== undefined || body.permissions !== undefined, 'No role changes supplied')

export default defineEventHandler(async (event) => {
  const workspaceId = getRouterParam(event, 'id')!
  const roleId = getRouterParam(event, 'roleId')!
  const actor = await requireMember(event, workspaceId, Permission.manageRoles)
  const body = parseBody(bodySchema, await readBody(event))
  const { env } = cf(event)
  const db = getDb(env.DB)
  const role = (await db.select().from(roles).where(eq(roles.id, roleId)).limit(1))[0]
  if (!role) fail(404, 'not_found', 'Role not found')
  if (role.isSystem) fail(403, 'forbidden', 'System roles cannot be changed')
  const permissions = body.permissions ?? role.permissionsBitmask
  assertGrantScope(actor, permissions)
  if (body.name !== undefined) {
    const existing = await db.select({ id: roles.id, name: roles.name }).from(roles)
    if (existing.some(item => item.id !== role.id && item.name.toLocaleLowerCase() === body.name!.toLocaleLowerCase())) {
      fail(409, 'conflict', 'A role with this name already exists')
    }
  }
  const updated = {
    ...role,
    name: body.name ?? role.name,
    permissionsBitmask: permissions,
    updatedAt: nowIso(),
  }
  await db.update(roles).set({
    name: updated.name,
    permissionsBitmask: updated.permissionsBitmask,
    updatedAt: updated.updatedAt,
  }).where(eq(roles.id, role.id))
  await writeAudit(env, {
    workspaceId,
    actorId: actor.user.id,
    action: 'role.update',
    targetType: 'role',
    targetId: role.id,
    meta: { name: updated.name, permissions: updated.permissionsBitmask },
  })
  return { role: toRoleDto(updated, workspaceId) }
})
