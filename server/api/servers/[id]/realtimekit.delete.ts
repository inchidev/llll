import { getServerId } from '../../../../shared/server-id'
import { eq } from 'drizzle-orm'
import { realtimekitSettings } from '../../../../drizzle/schema'
import type { RealtimeKitSettingsAdminDTO } from '../../../../shared/types'
import { loadRealtimeKitConfig, realtimekitSettingsAdminDto } from '../../../../workers/realtimekit'
import { cf, fail } from '../../../utils/cf'
import { getDb } from '../../../utils/db'
import { requireMember } from '../../../utils/guards'
import { closeLiveRooms } from '../../../utils/live'
import { writeAudit } from '../../../utils/messages'

export default defineEventHandler(async (event): Promise<{ realtimekit: RealtimeKitSettingsAdminDTO }> => {
  const serverId = getRouterParam(event, 'id')!
  const member = await requireMember(event, serverId)
  if (!member.isOwner) fail(403, 'forbidden', 'Only the owner can manage RealtimeKit')
  const { env } = cf(event)
  if ((await loadRealtimeKitConfig(env)).source === 'deployment') {
    fail(400, 'managed_by_deployment', 'RealtimeKit is managed by the deployment')
  }
  // End live rooms while their meetings can still be reached with this connection.
  await closeLiveRooms(env)
  await getDb(env.DB).delete(realtimekitSettings).where(eq(realtimekitSettings.id, 1))
  await writeAudit(env, {
    serverId: (await getServerId(cf(event).env.DB)),
    actorId: member.user.id,
    action: 'realtimekit.settings.remove',
    targetType: 'server',
    targetId: (await getServerId(cf(event).env.DB)),
  })
  return { realtimekit: realtimekitSettingsAdminDto(await loadRealtimeKitConfig(env)) }
})
