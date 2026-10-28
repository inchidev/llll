import { z } from 'zod'
import { roles } from '../../../../drizzle/schema'
import { newId, nowIso } from '../../../../shared/ids'
import { Permission } from '../../../../shared/permissions'
import { requireMember } from '../../../utils/guards'
import { cf, fail } from '../../../utils/cf'
import { getDb } from '../../../utils/db'
import { writeAudit } from '../../../utils/messages'
import { assertGrantScope, assertResourceGrantScope, toRoleDto } from '../../../utils/role-policy'
import { parseBody } from '../../../utils/validate'

const bodySchema = z.object({
  name: z.string().trim().min(1).max(40),
}).strict()

export default defineEventHandler(async (event) => {
  const serverId = getRouterParam(event, 'id')!
  const actor = await requireMember(event, serverId, Permission.manageRoles)
  const body = parseBody(bodySchema, await readBody(event))
  assertGrantScope(actor, 0)
  assertResourceGrantScope(actor, {})
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
    permissionsBitmask: 0,
    resourceAccessJson: '{}',
    position: Math.max(...existing.map(item => item.position), 0) + 1,
    isSystem: false,
    createdAt,
    updatedAt: createdAt,
  }
  await db.insert(roles).values(role)
  await writeAudit(env, {
    serverId,
    actorId: actor.user.id,
    action: 'role.create',
    targetType: 'role',
    targetId: id,
    meta: { name: role.name, permissions: role.permissionsBitmask },
  })
  return { role: toRoleDto(role, serverId) }
})
