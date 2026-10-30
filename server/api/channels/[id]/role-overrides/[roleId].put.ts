import { z } from 'zod'
import { CHANNEL_PERMISSION_MASK, isChannelPermissionMask } from '../../../../../shared/channel-permissions'
import { cf } from '../../../../utils/cf'
import { requireChannelOverrideManager, requireOverridableRole, setChannelRoleOverride } from '../../../../utils/channel-role-overrides'
import { getDb } from '../../../../utils/db'
import { writeAudit } from '../../../../utils/messages'
import { parseBody } from '../../../../utils/validate'

const bodySchema = z.object({
  allow: z.number().int().min(0).max(CHANNEL_PERMISSION_MASK),
  deny: z.number().int().min(0).max(CHANNEL_PERMISSION_MASK),
}).superRefine((body, ctx) => {
  if (!isChannelPermissionMask(body.allow) || !isChannelPermissionMask(body.deny)) {
    ctx.addIssue({ code: 'custom', message: 'Unsupported channel permission' })
  }
  if ((body.allow & body.deny) !== 0) {
    ctx.addIssue({ code: 'custom', message: 'A permission cannot be both allowed and denied' })
  }
})

export default defineEventHandler(async (event) => {
  const channelId = getRouterParam(event, 'id')!
  const roleId = getRouterParam(event, 'roleId')!
  const actor = await requireChannelOverrideManager(event, channelId)
  const body = parseBody(bodySchema, await readBody(event))
  const { env } = cf(event)
  const db = getDb(env.DB)
  await requireOverridableRole(db, roleId)
  await setChannelRoleOverride(env, channelId, roleId, body.allow, body.deny, actor.user.id)
  await writeAudit(env, {
    serverId: actor.serverId,
    actorId: actor.user.id,
    action: 'channel.permissions.update',
    targetType: 'channel',
    targetId: channelId,
    meta: { roleId, allow: body.allow, deny: body.deny },
  })
  return {
    override: body.allow === 0 && body.deny === 0
      ? null
      : { channelId, roleId, allow: body.allow, deny: body.deny },
  }
})
