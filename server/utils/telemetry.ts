import type { TelemetryHeartbeat } from '../../shared/telemetry'
import { agentRuntimeConfigured, type L4Env } from '../../workers/env'
import { workspaceEmailAvailable } from '../../workers/mail-transport'
import { liveAvailable } from '../../workers/realtimekit'
import { workspaceMailDomains } from './workspace-mail'

const DEFAULT_ENDPOINT = 'https://llll.gg/api/telemetry/heartbeat'

export async function telemetryEnabled(db: D1Database): Promise<boolean> {
  try {
    const row = await db.prepare("SELECT enabled FROM telemetry_settings WHERE id = 'main'").first<{ enabled: number | boolean }>()
    return row?.enabled === true || row?.enabled === 1
  }
  catch {
    // A release should never report before its telemetry migration has applied.
    return false
  }
}

export function telemetryHeartbeat(env: L4Env, sentAt = new Date().toISOString(), live = false): TelemetryHeartbeat | null {
  const installationId = env.LLLL_TELEMETRY_ID?.trim()
  const version = env.LLLL_VERSION?.trim()
  if (!installationId || !version || !env.LLLL_TELEMETRY_TOKEN) return null

  return {
    schemaVersion: 1,
    installationId,
    version,
    sentAt,
    capabilities: {
      d1: Boolean(env.DB),
      r2: Boolean(env.FILES),
      kv: Boolean(env.TICKETS),
      customDomain: env.LLLL_CUSTOM_DOMAIN === 'true',
      email: Boolean(workspaceMailDomains(env).length && (workspaceEmailAvailable(env) || env.EMAIL)),
      agents: agentRuntimeConfigured(env),
      // The heartbeat schema keeps its pre-Live field name.
      huddles: live,
    },
  }
}

export async function sendTelemetryHeartbeat(
  env: L4Env,
  fetcher: typeof fetch = fetch,
): Promise<'sent' | 'disabled' | 'unavailable'> {
  const heartbeat = telemetryHeartbeat(env, undefined, await liveAvailable(env).catch(() => false))
  if (!heartbeat) return 'unavailable'
  if (!await telemetryEnabled(env.DB)) return 'disabled'

  const response = await fetcher(env.LLLL_TELEMETRY_ENDPOINT?.trim() || DEFAULT_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.LLLL_TELEMETRY_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(heartbeat),
  })
  if (!response.ok) throw new Error(`Telemetry heartbeat returned ${response.status}`)
  return 'sent'
}
