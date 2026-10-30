import { eq } from 'drizzle-orm'
import type { H3Event } from 'h3'
import { roles } from '../../drizzle/schema'
import { CHANNEL_ROLE_OVERRIDE_SQL } from '../../shared/channel-permissions'
import { newId, nowIso } from '../../shared/ids'
import { Permission } from '../../shared/permissions'
import type { ChannelRoleOverrideDTO } from '../../shared/types'
import type { L4Env } from '../../workers/env'
import { fail } from './cf'
import { requireChannelAccess } from './guards'

export async function requireChannelOverrideManager(event: H3Event, channelId: string) {
  const access = await requireChannelAccess(event, channelId, Permission.manageChannels)
  if (access.channel.type !== 'text') {
    fail(400, 'bad_request', 'Permission overrides are only available for server channels')
  }
  return access
}

export async function requireOverridableRole(db: ReturnType<typeof import('./db').getDb>, roleId: string) {
  const role = (await db.select().from(roles).where(eq(roles.id, roleId)).limit(1))[0]
  if (!role) fail(404, 'not_found', 'Role not found')
  if (role.key === 'owner') fail(400, 'bad_request', 'The owner always has every channel permission')
  return role
}

export async function channelRoleOverride(env: L4Env, channelId: string, roleId: string) {
  return env.DB.prepare(CHANNEL_ROLE_OVERRIDE_SQL).bind(channelId, roleId).first<{ allow: number | null; deny: number | null }>()
}

export async function listChannelRoleOverrides(env: L4Env, channelId: string): Promise<ChannelRoleOverrideDTO[]> {
  const rows = await env.DB.prepare(`SELECT role_id AS roleId, max(allow) AS allow, max(deny) AS deny FROM (
      SELECT role_id, permissions AS allow, 0 AS deny FROM grants WHERE channel_id = ?1
      UNION ALL SELECT role_id, 0, deny_mask FROM channel_role_denies WHERE channel_id = ?1
    ) GROUP BY role_id ORDER BY role_id`).bind(channelId).all<{ roleId: string; allow: number; deny: number }>()
  return rows.results.map(row => ({ channelId, roleId: row.roleId, allow: row.allow, deny: row.deny }))
}

/** Replace a Role's override on a channel: its allow grant and its deny. Zero removes either. */
export async function setChannelRoleOverride(env: L4Env, channelId: string, roleId: string, allow: number, deny: number, actorId: string) {
  const now = nowIso()
  await env.DB.batch([
    env.DB.prepare('DELETE FROM grants WHERE channel_id = ? AND role_id = ?').bind(channelId, roleId),
    env.DB.prepare('DELETE FROM channel_role_denies WHERE channel_id = ? AND role_id = ?').bind(channelId, roleId),
    ...allow ? [env.DB.prepare('INSERT INTO grants (id, role_id, permissions, channel_id, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)').bind(newId(), roleId, allow, channelId, actorId, now)] : [],
    ...deny ? [env.DB.prepare('INSERT INTO channel_role_denies (channel_id, role_id, deny_mask, created_at) VALUES (?, ?, ?, ?)').bind(channelId, roleId, deny, now)] : [],
  ])
}
