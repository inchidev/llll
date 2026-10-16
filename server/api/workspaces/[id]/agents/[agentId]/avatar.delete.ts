import { and, eq } from 'drizzle-orm'
import { agents, users } from '../../../../../../drizzle/schema'
import { nowIso } from '../../../../../../shared/ids'
import { Permission } from '../../../../../../shared/permissions'
import { signalMembersChanged } from '../../../../../../workers/member-events'
import { cf, requireFiles, fail } from '../../../../../utils/cf'
import { getDb } from '../../../../../utils/db'
import { requireMember } from '../../../../../utils/guards'
import { writeAudit } from '../../../../../utils/messages'

export default defineEventHandler(async (event) => {
  const workspaceId = getRouterParam(event, 'id')!
  const agentId = getRouterParam(event, 'agentId')!
  const actor = await requireMember(event, workspaceId, Permission.manageWorkspace)
  const { env, waitUntil } = cf(event)
  const db = getDb(env.DB)
  const current = (await db.select({ avatarR2Key: users.avatarR2Key }).from(users)
    .innerJoin(agents, eq(agents.userId, users.id))
    .where(and(eq(users.id, agentId), eq(users.kind, 'agent')))
    .limit(1))[0]
  if (!current) fail(404, 'not_found', 'Agent not found')
  const now = nowIso()
  await db.batch([
    db.update(users).set({ avatarR2Key: null, updatedAt: now }).where(eq(users.id, agentId)),
    db.update(agents).set({ updatedAt: now }).where(eq(agents.userId, agentId)),
  ])
  if (current.avatarR2Key) await requireFiles(env).delete(current.avatarR2Key)
  await writeAudit(env, {
    workspaceId,
    actorId: actor.user.id,
    action: 'agent.avatar.delete',
    targetType: 'agent',
    targetId: agentId,
  })
  waitUntil(signalMembersChanged(env, workspaceId))
  return { ok: true }
})
