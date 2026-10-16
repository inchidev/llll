import { eq } from 'drizzle-orm'
import { agents, users } from '../../../../../drizzle/schema'
import { nowIso } from '../../../../../shared/ids'
import { Permission } from '../../../../../shared/permissions'
import { requireMember } from '../../../../utils/guards'
import { cf, fail } from '../../../../utils/cf'
import { getDb } from '../../../../utils/db'
import { writeAudit } from '../../../../utils/messages'
import { signalMembersChanged } from '../../../../../workers/member-events'
import { revalidateLiveRooms } from '../../../../utils/live'

export default defineEventHandler(async (event) => {
  const workspaceId = getRouterParam(event, 'id')!
  const userId = getRouterParam(event, 'userId')!
  const actor = await requireMember(event, workspaceId, Permission.kick)
  if (userId === actor.ownerId) fail(403, 'forbidden', 'Owner cannot be kicked')
  if (userId === actor.user.id) fail(400, 'bad_request', 'Leave is not implemented; ask an admin')
  const { env, waitUntil } = cf(event)
  const db = getDb(env.DB)
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
  await writeAudit(env, { workspaceId, actorId: actor.user.id, action: 'member.kick', targetType: 'user', targetId: userId })
  waitUntil(signalMembersChanged(env, workspaceId))
  // A removed member leaves every Live room they are in, and their tokens stop working.
  waitUntil(revalidateLiveRooms(env))
  return { ok: true }
})
