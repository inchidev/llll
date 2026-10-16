import { and, eq } from 'drizzle-orm'
import { channelRoleOverrides } from '../../../../../drizzle/schema'
import { cf } from '../../../../utils/cf'
import { requireChannelOverrideManager, requireOverridableRole } from '../../../../utils/channel-role-overrides'
import { getDb } from '../../../../utils/db'
import { writeAudit } from '../../../../utils/messages'

export default defineEventHandler(async (event) => {
  const channelId = getRouterParam(event, 'id')!
  const roleId = getRouterParam(event, 'roleId')!
  const actor = await requireChannelOverrideManager(event, channelId)
  const { env } = cf(event)
  const db = getDb(env.DB)
  await requireOverridableRole(db, roleId)
  await db.delete(channelRoleOverrides).where(and(
    eq(channelRoleOverrides.channelId, channelId),
    eq(channelRoleOverrides.roleId, roleId),
  ))
  await writeAudit(env, {
    workspaceId: actor.workspaceId,
    actorId: actor.user.id,
    action: 'channel.permissions.reset',
    targetType: 'channel',
    targetId: channelId,
    meta: { roleId },
  })
  return { ok: true }
})
