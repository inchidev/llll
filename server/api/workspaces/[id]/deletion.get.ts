import type { ServerDeletionStatusDTO } from '../../../../shared/deletion'
import { fail } from '../../../utils/cf'
import { requireMember } from '../../../utils/guards'

export default defineEventHandler(async (event): Promise<ServerDeletionStatusDTO> => {
  setHeader(event, 'Cache-Control', 'no-store')
  const workspaceId = getRouterParam(event, 'id')!
  const member = await requireMember(event, workspaceId)
  if (!member.isOwner) fail(403, 'forbidden', 'Only the owner can delete this server')

  return { managedBy: 'operator' }
})
