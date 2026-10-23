import { cf, fail } from '../../../../utils/cf'
import { writeAudit } from '../../../../utils/messages'
import { privateChannelMembers, refreshPrivateChannelAccess, requirePrivateChannelManager } from '../../../../utils/private-channel-members'

export default defineEventHandler(async event => {
  const id = getRouterParam(event, 'id')!
  const userId = getRouterParam(event, 'userId')!
  const actor = await requirePrivateChannelManager(event, id)
  if (userId === actor.user.id) fail(400, 'self_removal', 'Ask another channel manager to remove your access')
  const { env } = cf(event)
  const removed = await env.DB.prepare(`DELETE FROM channel_members WHERE channel_id=? AND user_id=?
    AND EXISTS(SELECT 1 FROM channel_members actor WHERE actor.channel_id=? AND actor.user_id=?) RETURNING user_id`)
    .bind(id, userId, id, actor.user.id).first()
  if (!removed) await requirePrivateChannelManager(event, id)
  if (removed) await writeAudit(env, { serverId: actor.serverId, actorId: actor.user.id, action: 'channel.member.remove', targetType: 'channel', targetId: id, meta: { userId } })
  await refreshPrivateChannelAccess(env, actor.serverId, id, removed ? userId : undefined)
  return { members: await privateChannelMembers(env, id) }
})
