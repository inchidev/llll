import { Permission } from '../../../../shared/permissions'
import { requireActiveChannel } from '../../../utils/channel-access'
import { requireChannelAccess } from '../../../utils/guards'
import { cf } from '../../../utils/cf'
import { openPortal } from '../../../utils/portals'
import { primaryServerOrigin } from '../../../utils/server-origins'

/**
 * Open a Portal in this conversation (ADR 0014): whoever may start Live here may share a Mac window into it.
 * Answers the guest link and the link that opens PartyPortal on the caller's Mac, each given out once.
 */
export default defineEventHandler(async (event) => {
  const channelId = getRouterParam(event, 'id')!
  const access = await requireChannelAccess(event, channelId, Permission.startLive)
  requireActiveChannel(access)
  const { env } = cf(event)
  const origin = await primaryServerOrigin(env, getRequestURL(event).origin)
  const opened = await openPortal(env, { channelId, userId: access.user.id, origin })
  setHeader(event, 'Cache-Control', 'no-store')
  return opened
})
