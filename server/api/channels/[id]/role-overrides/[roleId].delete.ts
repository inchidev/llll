import { cf } from '../../../../utils/cf'
import { requireChannelOverrideManager, requireOverridableRole, setChannelRoleOverride } from '../../../../utils/channel-role-overrides'
import { getDb } from '../../../../utils/db'
import { writeAudit } from '../../../../utils/messages'

export default defineEventHandler(async (event) => {
  const channelId = getRouterParam(event, 'id')!
  const roleId = getRouterParam(event, 'roleId')!
  const actor = await requireChannelOverrideManager(event, channelId)
  const { env } = cf(event)
  const db = getDb(env.DB)
  await requireOverridableRole(db, roleId)
  await setChannelRoleOverride(env, channelId, roleId, 0, 0, actor.user.id)
  await writeAudit(env, {
    serverId: actor.serverId,
    actorId: actor.user.id,
    action: 'channel.permissions.reset',
    targetType: 'channel',
    targetId: channelId,
    meta: { roleId },
  })
  return { ok: true }
})
