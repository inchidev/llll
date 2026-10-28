import { Permission } from '../../../../shared/permissions'
import { requireChannelMember } from '../../../utils/guards'
import { cf } from '../../../utils/cf'
import { setChannelArchived } from '../../../utils/channel-lifecycle'

/** Archive a Chat channel: its history stays readable, it leaves navigation and accepts no new activity. */
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const member = await requireChannelMember(event, id, Permission.manageChannels)
  const { env, waitUntil } = cf(event)
  const result = await setChannelArchived(env, member, true, waitUntil)
  return { ok: true, archived: true, ...result }
})
