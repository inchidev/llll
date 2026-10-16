import type { RealtimeKitSettingsAdminDTO } from '../../../../shared/types'
import { loadRealtimeKitConfig, realtimekitSettingsAdminDto } from '../../../../workers/realtimekit'
import { cf, fail } from '../../../utils/cf'
import { llllAdmin, llllAdminWorkspaceUrl } from '../../../../workers/llll-admin'
import { requireMember } from '../../../utils/guards'

export default defineEventHandler(async (event): Promise<{ realtimekit: RealtimeKitSettingsAdminDTO }> => {
  setHeader(event, 'Cache-Control', 'no-store')
  const workspaceId = getRouterParam(event, 'id')!
  const member = await requireMember(event, workspaceId)
  if (!member.isOwner) fail(403, 'forbidden', 'Only the owner can manage RealtimeKit')
  const { env } = cf(event)
  const admin = llllAdmin(env)
  if (admin) {
    const live = await admin.liveStatus().catch(() => null)
    return {
      realtimekit: {
        ...realtimekitSettingsAdminDto(await loadRealtimeKitConfig(env)),
        configured: true,
        source: 'admin',
        appId: live?.appId ?? null,
        adminUrl: await llllAdminWorkspaceUrl(env),
      },
    }
  }
  return { realtimekit: realtimekitSettingsAdminDto(await loadRealtimeKitConfig(env)) }
})
