import { hasPermission, Permission } from '../../../../../shared/permissions'
import { PORTAL_ID } from '../../../../../shared/portal'
import { requireChannelAccess } from '../../../../utils/guards'
import { cf, fail } from '../../../../utils/cf'
import { portalRoom } from '../../../../utils/portals'

/** End a Portal: the person who opened it, or anyone who manages the conversation. */
export default defineEventHandler(async (event) => {
  const channelId = getRouterParam(event, 'id')!
  const portalId = getRouterParam(event, 'portalId')!
  const access = await requireChannelAccess(event, channelId)
  if (!PORTAL_ID.test(portalId)) fail(404, 'not_found', 'Portal not found')
  const room = portalRoom(cf(event).env, portalId)
  const record = await room.record()
  if (!record || record.channelId !== channelId) fail(404, 'not_found', 'Portal not found')
  if (record.createdBy !== access.user.id && !access.isOwner && !hasPermission(access.perms, Permission.manageChannels)) {
    fail(403, 'forbidden', 'Only the person who opened this Portal or a channel manager can end it')
  }
  await room.end()
  return { ok: true }
})
