import type { TelemetrySettingsDTO } from '../../../../shared/telemetry'
import { cf, fail } from '../../../utils/cf'
import { requireMember } from '../../../utils/guards'

export default defineEventHandler(async (event): Promise<TelemetrySettingsDTO> => {
  setHeader(event, 'Cache-Control', 'no-store')
  const workspaceId = getRouterParam(event, 'id')!
  const member = await requireMember(event, workspaceId)
  if (!member.isOwner) fail(403, 'forbidden', 'Only the owner can manage telemetry')

  const { env } = cf(event)
  const row = await env.DB.prepare("SELECT enabled FROM telemetry_settings WHERE id = 'main'").first<{ enabled: number | boolean }>()
  return {
    enabled: row?.enabled === true || row?.enabled === 1,
    available: Boolean(env.LLLL_TELEMETRY_ID && env.LLLL_TELEMETRY_TOKEN),
  }
})
