import { eq } from 'drizzle-orm'
import type { H3Event } from 'h3'
import { roles } from '../../drizzle/schema'
import { Permission } from '../../shared/permissions'
import type { ChannelRoleOverrideDTO } from '../../shared/types'
import { fail } from './cf'
import { requireChannelAccess } from './guards'

export async function requireChannelOverrideManager(event: H3Event, channelId: string) {
  const access = await requireChannelAccess(event, channelId, Permission.manageChannels)
  if (access.channel.type !== 'text') {
    fail(400, 'bad_request', 'Permission overrides are only available for workspace channels')
  }
  return access
}

export async function requireOverridableRole(db: ReturnType<typeof import('./db').getDb>, roleId: string) {
  const role = (await db.select().from(roles).where(eq(roles.id, roleId)).limit(1))[0]
  if (!role) fail(404, 'not_found', 'Role not found')
  if (role.key === 'owner') fail(400, 'bad_request', 'The owner always has every channel permission')
  return role
}

export function toChannelRoleOverrideDto(row: {
  channelId: string
  roleId: string
  allowMask: number
  denyMask: number
}): ChannelRoleOverrideDTO {
  return {
    channelId: row.channelId,
    roleId: row.roleId,
    allow: row.allowMask,
    deny: row.denyMask,
  }
}
