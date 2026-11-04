import { getServerId } from '../../../../../shared/server-id'
import {
  loadRealtimeKitConfig,
  RealtimeKitHttpError,
  realtimekitConfigured,
  testRealtimeKitConnection,
  type RealtimeKitConnectionTestResult,
} from '../../../../../workers/realtimekit'
import { cf, fail } from '../../../../utils/cf'
import { requireMember } from '../../../../utils/guards'
import { writeAudit } from '../../../../utils/messages'

export default defineEventHandler(async (event): Promise<RealtimeKitConnectionTestResult & { ok: true }> => {
  setHeader(event, 'Cache-Control', 'no-store, max-age=0')
  const serverId = getRouterParam(event, 'id')!
  const member = await requireMember(event, serverId)
  if (!member.isOwner) fail(403, 'forbidden', 'Only the owner can test RealtimeKit')
  const { env } = cf(event)
  const config = await loadRealtimeKitConfig(env)
  if (!realtimekitConfigured(config)) fail(400, 'realtimekit_unconfigured', 'Connect RealtimeKit first')

  let result: RealtimeKitConnectionTestResult
  try {
    result = await testRealtimeKitConnection(config)
  }
  catch (error) {
    const message = error instanceof Error ? error.message : 'RealtimeKit connection failed'
    if (message.startsWith('RealtimeKit preset not found:')) fail(400, 'preset_not_found', message)
    if (error instanceof RealtimeKitHttpError && (error.status === 401 || error.status === 403)) {
      fail(400, 'invalid_credentials', 'RealtimeKit rejected the API token or account')
    }
    if (error instanceof RealtimeKitHttpError && error.status === 404) fail(400, 'app_not_found', 'RealtimeKit app not found')
    fail(502, 'realtimekit_connection_failed', message)
  }

  await writeAudit(env, {
    serverId: (await getServerId(cf(event).env.DB)),
    actorId: member.user.id,
    action: 'realtimekit.connection.test',
    targetType: 'server',
    targetId: (await getServerId(cf(event).env.DB)),
    meta: { source: config.source, hostPreset: config.hostPreset, participantPreset: config.participantPreset },
  })
  return { ok: true, ...result }
})
