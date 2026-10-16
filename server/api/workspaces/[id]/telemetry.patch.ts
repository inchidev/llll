import { z } from 'zod'
import type { TelemetrySettingsDTO } from '../../../../shared/telemetry'
import { nowIso } from '../../../../shared/ids'
import { cf, fail } from '../../../utils/cf'
import { requireMember } from '../../../utils/guards'
import { parseBody } from '../../../utils/validate'
import { writeAudit } from '../../../utils/messages'

const bodySchema = z.object({ enabled: z.boolean() })

export default defineEventHandler(async (event): Promise<TelemetrySettingsDTO> => {
  const workspaceId = getRouterParam(event, 'id')!
  const member = await requireMember(event, workspaceId)
  if (!member.isOwner) fail(403, 'forbidden', 'Only the owner can manage telemetry')
  const body = parseBody(bodySchema, await readBody(event))
  const { env } = cf(event)
  const updatedAt = nowIso()

  await env.DB.prepare(
    `INSERT INTO telemetry_settings (id, enabled, updated_at) VALUES ('main', ?, ?)
     ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at`,
  ).bind(body.enabled ? 1 : 0, updatedAt).run()
  await writeAudit(env, {
    workspaceId,
    actorId: member.user.id,
    action: body.enabled ? 'telemetry.enable' : 'telemetry.disable',
    targetType: 'workspace',
    targetId: workspaceId,
  })

  return {
    enabled: body.enabled,
    available: Boolean(env.LLLL_TELEMETRY_ID && env.LLLL_TELEMETRY_TOKEN),
  }
})
