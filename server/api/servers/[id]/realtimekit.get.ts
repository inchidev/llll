import type { RealtimeKitSettingsAdminDTO } from '../../../../shared/types'
import { loadRealtimeKitConfig, realtimekitSettingsAdminDto } from '../../../../workers/realtimekit'
import { cf, fail } from '../../../utils/cf'
import { requireMember } from '../../../utils/guards'

export default defineEventHandler(async (event): Promise<{ realtimekit: RealtimeKitSettingsAdminDTO }> => {
  setHeader(event, 'Cache-Control', 'no-store')
  const serverId = getRouterParam(event, 'id')!
  const member = await requireMember(event, serverId)
  if (!member.isOwner) fail(403, 'forbidden', 'Only the owner can manage RealtimeKit')
  const { env } = cf(event)
  return { realtimekit: realtimekitSettingsAdminDto(await loadRealtimeKitConfig(env)) }
})
