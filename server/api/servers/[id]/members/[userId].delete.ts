import { and, eq } from 'drizzle-orm'
import { agents, roles, users } from '../../../../../drizzle/schema'
import { nowIso } from '../../../../../shared/ids'
import { Permission } from '../../../../../shared/permissions'
import { requireMember } from '../../../../utils/guards'
import { cf, fail } from '../../../../utils/cf'
import { getDb } from '../../../../utils/db'
import { writeAudit } from '../../../../utils/messages'
import { signalMembersChanged } from '../../../../../workers/member-events'
import { revalidateLiveRooms } from '../../../../utils/live'
import { assertRoleManageable } from '../../../../utils/role-policy'

export default defineEventHandler(async (event) => {
  const serverId = getRouterParam(event, 'id')!
  const userId = getRouterParam(event, 'userId')!
  const actor = await requireMember(event, serverId, Permission.kick)
  if (userId === actor.ownerId) fail(403, 'forbidden', 'Owner cannot be kicked')
  if (userId === actor.user.id) fail(400, 'bad_request', 'Leave is not implemented; ask an admin')
  const { env, waitUntil } = cf(event)
  const db = getDb(env.DB)
  const target = (await db.select({ role: roles }).from(users).innerJoin(roles, eq(roles.id, users.roleId))
    .where(and(eq(users.id, userId), eq(users.status, 'active'))).limit(1))[0]
  if (!target) fail(404, 'not_found', 'Member not found')
  assertRoleManageable(actor, target.role)
  const now = nowIso()
  await db.batch([
    db.update(users).set({
      status: 'removed',
      roleId: null,
      nickname: null,
      joinedAt: null,
      updatedAt: now,
    }).where(eq(users.id, userId)),
    db.update(agents).set({ status: 'paused', updatedAt: now }).where(eq(agents.userId, userId)),
  ])
  await writeAudit(env, { serverId, actorId: actor.user.id, action: 'member.kick', targetType: 'user', targetId: userId })
  waitUntil(signalMembersChanged(env, serverId))
  // A removed member leaves every Live room they are in, and their tokens stop working.
  waitUntil(revalidateLiveRooms(env))
  return { ok: true }
})
