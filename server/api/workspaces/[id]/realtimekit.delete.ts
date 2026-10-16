import { eq } from 'drizzle-orm'
import { realtimekitSettings } from '../../../../drizzle/schema'
import type { RealtimeKitSettingsAdminDTO } from '../../../../shared/types'
import { WORKSPACE_ID } from '../../../../shared/ids'
import { loadRealtimeKitConfig, realtimekitSettingsAdminDto } from '../../../../workers/realtimekit'
import { cf, fail } from '../../../utils/cf'
import { getDb } from '../../../utils/db'
import { requireMember } from '../../../utils/guards'
import { writeAudit } from '../../../utils/messages'

export default defineEventHandler(async (event): Promise<{ realtimekit: RealtimeKitSettingsAdminDTO }> => {
  const workspaceId = getRouterParam(event, 'id')!
  const member = await requireMember(event, workspaceId)
  if (!member.isOwner) fail(403, 'forbidden', 'Only the owner can manage RealtimeKit')
  const { env } = cf(event)
  if ((await loadRealtimeKitConfig(env)).source === 'deployment') {
    fail(400, 'managed_by_deployment', 'RealtimeKit is managed by the deployment')
  }
  await getDb(env.DB).delete(realtimekitSettings).where(eq(realtimekitSettings.id, 'main'))
  await writeAudit(env, {
    workspaceId: WORKSPACE_ID,
    actorId: member.user.id,
    action: 'realtimekit.settings.remove',
    targetType: 'workspace',
    targetId: WORKSPACE_ID,
  })
  return { realtimekit: realtimekitSettingsAdminDto(await loadRealtimeKitConfig(env)) }
})
