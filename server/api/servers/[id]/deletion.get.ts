import type { ServerDeletionStatusDTO } from '../../../../shared/deletion'
import { fail } from '../../../utils/cf'
import { requireMember } from '../../../utils/guards'

export default defineEventHandler(async (event): Promise<ServerDeletionStatusDTO> => {
  setHeader(event, 'Cache-Control', 'no-store')
  const serverId = getRouterParam(event, 'id')!
  const member = await requireMember(event, serverId)
  if (!member.isOwner) fail(403, 'forbidden', 'Only the owner can delete this server')

  return { managedBy: 'operator' }
})
