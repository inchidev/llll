import { Permission } from '../../../../shared/permissions'
import { requireChannelMember } from '../../../utils/guards'
import { cf } from '../../../utils/cf'
import { setChannelArchived } from '../../../utils/channel-lifecycle'

/** Restore an archived Chat channel to navigation and normal activity. */
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const member = await requireChannelMember(event, id, Permission.manageChannels)
  const { env, waitUntil } = cf(event)
  const result = await setChannelArchived(env, member, false, waitUntil)
  return { ok: true, archived: false, changed: result.changed }
})
