import type { BackupDestinationDTO } from '../../../../shared/backups'
import { authSecret } from '../../../utils/auth-config'
import { backupDestinationDto, loadBackupDestination } from '../../../utils/backup-destination'
import { cf, fail } from '../../../utils/cf'
import { requireMember } from '../../../utils/guards'

export default defineEventHandler(async (event): Promise<{ destination: BackupDestinationDTO }> => {
  setHeader(event, 'Cache-Control', 'no-store')
  const workspaceId = getRouterParam(event, 'id')!
  const member = await requireMember(event, workspaceId)
  if (!member.isOwner) fail(403, 'forbidden', 'Only the owner can manage backup destinations')
  const { env } = cf(event)
  const installationSecret = authSecret(env, getRequestURL(event).origin)
  return { destination: backupDestinationDto(await loadBackupDestination(env, installationSecret)) }
})
