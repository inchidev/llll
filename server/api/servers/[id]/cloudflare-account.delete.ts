import { disconnectCloudflareAccess } from '../../../utils/cloudflare-account-access'
import { fail, originOk } from '../../../utils/cf'
import { writeAudit } from '../../../utils/messages'
import { updateOwner } from '../../../utils/server-updates'

/** Forget the access here. An OAuth grant also stays revocable in Cloudflare's own settings. */
export default defineEventHandler(async event => {
  setHeader(event, 'Cache-Control', 'no-store')
  if (!await originOk(event)) fail(403, 'origin_denied', 'Disconnect Cloudflare from this Server')
  const { env, member, serverId } = await updateOwner(event)
  await disconnectCloudflareAccess(env)
  await writeAudit(env, { serverId, actorId: member.user.id, action: 'cloudflare.access.disconnect', targetType: 'server', targetId: serverId })
  return { connected: false }
})
