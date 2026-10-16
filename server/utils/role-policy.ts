import type { roles } from '../../drizzle/schema'
import { ALL_PERMISSIONS } from '../../shared/permissions'
import type { RoleDTO } from '../../shared/types'
import type { Membership } from './guards'
import { fail } from './cf'

type RoleRow = typeof roles.$inferSelect

export function toRoleDto(role: RoleRow, workspaceId: string, memberCount = 0): RoleDTO {
  return {
    id: role.id,
    workspaceId,
    key: role.key,
    name: role.name,
    permissions: role.permissionsBitmask,
    position: role.position,
    isSystem: role.isSystem,
    memberCount,
  }
}

export function assertGrantScope(actor: Membership, permissions: number) {
  if (permissions < 0 || permissions > ALL_PERMISSIONS || (permissions & ~actor.perms) !== 0) {
    fail(403, 'forbidden', 'Cannot grant permissions you do not have')
  }
}

export function assertRoleAssignable(actor: Membership, role: RoleRow) {
  if (role.key === 'owner') fail(403, 'forbidden', 'Owner role cannot be assigned')
  if (role.key === 'admin' && !actor.isOwner) fail(403, 'forbidden', 'Only the owner can assign the admin role')
  assertGrantScope(actor, role.permissionsBitmask)
}
