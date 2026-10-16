import type { RealtimeKitSettingsAdminDTO } from '../../../../shared/types'
import { loadRealtimeKitConfig, realtimekitSettingsAdminDto } from '../../../../workers/realtimekit'
import { cf, fail } from '../../../utils/cf'
import { requireMember } from '../../../utils/guards'

export default defineEventHandler(async (event): Promise<{ realtimekit: RealtimeKitSettingsAdminDTO }> => {
  setHeader(event, 'Cache-Control', 'no-store')
  const workspaceId = getRouterParam(event, 'id')!
  const member = await requireMember(event, workspaceId)
  if (!member.isOwner) fail(403, 'forbidden', 'Only the owner can manage RealtimeKit')
  const { env } = cf(event)
  return { realtimekit: realtimekitSettingsAdminDto(await loadRealtimeKitConfig(env)) }
})
