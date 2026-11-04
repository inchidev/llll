import { bytesToHex, randomBytes } from '@noble/hashes/utils.js'
import { and, eq } from 'drizzle-orm'
import { roles, users } from '../../../../../../drizzle/schema'
import { Permission } from '../../../../../../shared/permissions'
import { loadAuthRuntimeConfig } from '../../../../../utils/auth-config'
import { authRequestContext } from '../../../../../utils/better-auth'
import { authMode } from '../../../../../utils/cloudflare-access'
import { cf, fail } from '../../../../../utils/cf'
import { getDb } from '../../../../../utils/db'
import { requireMember } from '../../../../../utils/guards'
import { writeAudit } from '../../../../../utils/messages'
import { assertRoleManageable } from '../../../../../utils/role-policy'

const LINK_TTL_MS = 24 * 60 * 60 * 1000

/**
 * A one-time password link for a Member who has no mail to reset by. It uses Better Auth's
 * reset token, so /reset-password spends it once and signs the Member out everywhere.
 * Whoever holds the link can take the Account, so the Owner's Account never gets one (the
 * Owner has a recovery key), and the actor must have authority over the Member's role.
 */
export default defineEventHandler(async (event): Promise<{ url: string; expiresAt: string }> => {
  setHeader(event, 'Cache-Control', 'no-store')
  const serverId = getRouterParam(event, 'id')!
  const userId = getRouterParam(event, 'userId')!
  const actor = await requireMember(event, serverId, Permission.kick)
  const { env } = cf(event)
  if (authMode(env) === 'access') fail(400, 'managed_by_access', 'Cloudflare Access handles sign-in on this Server')
  if (!(await loadAuthRuntimeConfig(env, getRequestURL(event).origin)).enabled.password) fail(400, 'password_login_disabled', 'Password sign-in is off on this Server')
  if (userId === actor.ownerId) fail(403, 'forbidden', 'The Owner uses their recovery key')
  if (userId === actor.user.id) fail(400, 'bad_request', 'Change your own password in Account settings')
  const target = (await getDb(env.DB).select({ kind: users.kind, role: roles }).from(users).innerJoin(roles, eq(roles.id, users.roleId))
    .where(and(eq(users.id, userId), eq(users.status, 'active'))).limit(1))[0]
  if (!target) fail(404, 'not_found', 'Member not found')
  if (target.kind !== 'human') fail(400, 'bad_request', 'Agents have no password')
  assertRoleManageable(actor, target.role)

  const token = bytesToHex(randomBytes(32))
  const now = Date.now()
  const expiresAt = now + LINK_TTL_MS
  await env.DB.batch([
    // One live link per Member: a new one replaces any earlier link or emailed reset.
    env.DB.prepare('DELETE FROM auth_verifications WHERE value = ? AND identifier LIKE ?').bind(userId, 'reset-password:%'),
    env.DB.prepare('INSERT INTO auth_verifications (id, identifier, value, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(crypto.randomUUID(), `reset-password:${token}`, userId, expiresAt, now, now),
  ])
  await writeAudit(env, { serverId, actorId: actor.user.id, action: 'member.password_reset_link', targetType: 'user', targetId: userId })
  const { baseURL } = await authRequestContext(event)
  return { url: new URL(`/reset-password?token=${token}`, baseURL).toString(), expiresAt: new Date(expiresAt).toISOString() }
})
