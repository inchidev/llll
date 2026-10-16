import { z } from 'zod'
import { roles } from '../../../../drizzle/schema'
import { newId, nowIso } from '../../../../shared/ids'
import { ALL_PERMISSIONS, MemberPermissions, Permission } from '../../../../shared/permissions'
import { requireMember } from '../../../utils/guards'
import { cf, fail } from '../../../utils/cf'
import { getDb } from '../../../utils/db'
import { writeAudit } from '../../../utils/messages'
import { assertGrantScope, toRoleDto } from '../../../utils/role-policy'
import { parseBody } from '../../../utils/validate'

const bodySchema = z.object({
  name: z.string().trim().min(1).max(40),
  permissions: z.number().int().min(0).max(ALL_PERMISSIONS).default(MemberPermissions),
})

export default defineEventHandler(async (event) => {
  const workspaceId = getRouterParam(event, 'id')!
  const actor = await requireMember(event, workspaceId, Permission.manageRoles)
  const body = parseBody(bodySchema, await readBody(event))
  assertGrantScope(actor, body.permissions)
  const { env } = cf(event)
  const db = getDb(env.DB)
  const existing = await db.select({ name: roles.name, position: roles.position }).from(roles)
  if (existing.some(role => role.name.toLocaleLowerCase() === body.name.toLocaleLowerCase())) {
    fail(409, 'conflict', 'A role with this name already exists')
  }
  const id = newId()
  const createdAt = nowIso()
  const role = {
    id,
    key: `custom:${id}`,
    name: body.name,
    permissionsBitmask: body.permissions,
    position: Math.max(...existing.map(item => item.position), 0) + 1,
    isSystem: false,
    createdAt,
    updatedAt: createdAt,
  }
  await db.insert(roles).values(role)
  await writeAudit(env, {
    workspaceId,
    actorId: actor.user.id,
    action: 'role.create',
    targetType: 'role',
    targetId: id,
    meta: { name: role.name, permissions: role.permissionsBitmask },
  })
  return { role: toRoleDto(role, workspaceId) }
})
