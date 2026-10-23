import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { users } from '../../../../drizzle/schema'
import { hasPermission, Permission } from '../../../../shared/permissions'
import { nowIso } from '../../../../shared/ids'
import { cf, fail } from '../../../utils/cf'
import { getDb } from '../../../utils/db'
import { writeAudit } from '../../../utils/messages'
import { privateChannelMembers, refreshPrivateChannelAccess, requirePrivateChannelManager } from '../../../utils/private-channel-members'
import { parseBody } from '../../../utils/validate'

const bodySchema = z.object({ userId: z.string().min(8) })

export default defineEventHandler(async event => {
  const id = getRouterParam(event, 'id')!
  const actor = await requirePrivateChannelManager(event, id)
  const { userId } = parseBody(bodySchema, await readBody(event))
  const { env } = cf(event)
  const target = (await getDb(env.DB).select({ kind: users.kind }).from(users)
    .where(and(eq(users.id, userId), eq(users.status, 'active'))).limit(1))[0]
  if (!target) fail(400, 'invalid_member', 'Choose an active Server member')
  if (target.kind === 'agent' && !hasPermission(actor.perms, Permission.useAgents)) fail(403, 'forbidden', 'Use agents permission is required to add an Agent')
  const added = await env.DB.prepare(`INSERT OR IGNORE INTO channel_members(channel_id,user_id,hidden_at,joined_at)
    SELECT ?,?,NULL,? WHERE EXISTS(SELECT 1 FROM channel_members WHERE channel_id=? AND user_id=?)
    AND EXISTS(SELECT 1 FROM users WHERE id=? AND status='active') RETURNING user_id`)
    .bind(id, userId, nowIso(), id, actor.user.id, userId).first()
  // Recheck admission after a conditional no-op; a concurrent removal must not be ignored.
  if (!added) {
    await requirePrivateChannelManager(event, id)
    const existing = await env.DB.prepare(`SELECT cm.user_id FROM channel_members cm JOIN users u ON u.id=cm.user_id
      WHERE cm.channel_id=? AND cm.user_id=? AND u.status='active'`).bind(id, userId).first()
    if (!existing) fail(400, 'invalid_member', 'Choose an active Server member')
  }
  if (added) {
    await writeAudit(env, { serverId: actor.serverId, actorId: actor.user.id, action: 'channel.member.add', targetType: 'channel', targetId: id, meta: { userId } })
  }
  await refreshPrivateChannelAccess(env, actor.serverId, id)
  return { members: await privateChannelMembers(env, id) }
})
