import { decryptSecret } from '../shared/encrypted-secret'
import type { RealtimeKitSettingsAdminDTO } from '../shared/types'
import { callsProvider, type L4Env } from './env'
import {
  LLLL_HOST_PRESET,
  LLLL_PARTICIPANT_PRESET,
  testRealtimeKitApp,
  type RealtimeKitConnectionTestResult,
} from '../packages/deployment-core/src/realtimekit'

// The REST client is shared with the installation deployment library.
export {
  addParticipant,
  connectRealtimeKit,
  createMeeting,
  LLLL_HOST_PRESET,
  LLLL_PARTICIPANT_PRESET,
  endMeeting,
  ensureLivePresets,
  findOrCreateApp,
  RealtimeKitHttpError,
  removeParticipants,
  type RealtimeKitAccount,
  type RealtimeKitConnectionTestResult,
  type RealtimeKitParticipant,
} from '../packages/deployment-core/src/realtimekit'

export const REALTIMEKIT_SECRET_SCOPE = 'realtimekit-api-token'

// Deployment-managed apps fall back to the presets RealtimeKit creates with a dashboard app.
const DEFAULT_HOST_PRESET = 'group_call_host'
const DEFAULT_PARTICIPANT_PRESET = 'group_call_participant'

export type RealtimeKitRuntimeConfig = {
  accountId: string
  appId: string
  apiToken: string
  hostPreset: string
  participantPreset: string
  source: 'deployment' | 'database' | 'missing'
  apiTokenConfigured: boolean
  secretReadable: boolean
}

type RealtimeKitSettingsRow = {
  account_id: string
  app_id: string
  api_token_ciphertext: string
  api_token_iv: string
  api_token_version: number
  host_preset: string
  participant_preset: string
}

function blankConfig(): RealtimeKitRuntimeConfig {
  return {
    accountId: '',
    appId: '',
    apiToken: '',
    hostPreset: LLLL_HOST_PRESET,
    participantPreset: LLLL_PARTICIPANT_PRESET,
    source: 'missing',
    apiTokenConfigured: false,
    secretReadable: true,
  }
}

/**
 * Presets named by the deployment. Installs made before hosts and participants
 * were split name only `REALTIMEKIT_PRESET_AV`, and their app may have no
 * default presets, so everyone keeps sharing that one until it is reconnected.
 */
function deploymentPresets(env: L4Env): { hostPreset: string, participantPreset: string } {
  const host = env.REALTIMEKIT_PRESET_HOST?.trim()
  const participant = env.REALTIMEKIT_PRESET_PARTICIPANT?.trim()
  const legacy = env.REALTIMEKIT_PRESET_AV?.trim()
  if (host || participant) {
    return { hostPreset: host || participant!, participantPreset: participant || host! }
  }
  if (legacy) return { hostPreset: legacy, participantPreset: legacy }
  return { hostPreset: DEFAULT_HOST_PRESET, participantPreset: DEFAULT_PARTICIPANT_PRESET }
}

/**
 * One source at a time: complete deployment variables override everything the
 * owner saved in Workspace Settings, including presets.
 */
export async function loadRealtimeKitConfig(env: L4Env): Promise<RealtimeKitRuntimeConfig> {
  const accountId = env.REALTIMEKIT_ACCOUNT_ID?.trim() || ''
  const appId = env.REALTIMEKIT_APP_ID?.trim() || ''
  // REALTIMEKIT_API_KEY and REALTIMEKIT_PRESET_AV are the pre-Live names.
  const apiToken = env.REALTIMEKIT_API_TOKEN?.trim() || env.REALTIMEKIT_API_KEY?.trim() || ''
  if (accountId && appId && apiToken) {
    return {
      accountId,
      appId,
      apiToken,
      ...deploymentPresets(env),
      source: 'deployment',
      apiTokenConfigured: true,
      secretReadable: true,
    }
  }

  let row: RealtimeKitSettingsRow | null
  try {
    row = await env.DB.prepare(
      `SELECT account_id, app_id, api_token_ciphertext, api_token_iv, api_token_version,
              host_preset, participant_preset
       FROM realtimekit_settings WHERE id = 'main'`,
    ).first<RealtimeKitSettingsRow>()
  }
  catch {
    return blankConfig()
  }
  if (!row) return blankConfig()

  const hostPreset = row.host_preset.trim() || LLLL_HOST_PRESET
  const config: RealtimeKitRuntimeConfig = {
    accountId: row.account_id.trim(),
    appId: row.app_id.trim(),
    apiToken: '',
    hostPreset,
    participantPreset: row.participant_preset.trim() || hostPreset,
    source: 'database',
    apiTokenConfigured: Boolean(row.api_token_ciphertext),
    secretReadable: true,
  }
  const installationSecret = env.AUTH_SECRET?.trim()
  if (!installationSecret) {
    config.secretReadable = false
    return config
  }
  try {
    config.apiToken = await decryptSecret(installationSecret, REALTIMEKIT_SECRET_SCOPE, {
      ciphertext: row.api_token_ciphertext,
      iv: row.api_token_iv,
      version: row.api_token_version,
    })
  }
  catch {
    config.secretReadable = false
  }
  return config
}

export function realtimekitConfigured(config: RealtimeKitRuntimeConfig): boolean {
  return Boolean(config.accountId && config.appId && config.apiToken)
}

/** Whether Live rooms can start. Health, installation status, and telemetry all use this one answer. */
export async function liveAvailable(env: L4Env): Promise<boolean> {
  if (realtimekitConfigured(await loadRealtimeKitConfig(env))) return true
  // Off Cloudflare, the shared API token provisions an app on the first call.
  return callsProvider(env) === 'realtimekit-rest'
}

export function realtimekitSettingsAdminDto(config: RealtimeKitRuntimeConfig): RealtimeKitSettingsAdminDTO {
  return {
    configured: realtimekitConfigured(config),
    source: config.source,
    accountId: config.accountId || null,
    appId: config.appId || null,
    apiTokenConfigured: config.apiTokenConfigured,
    secretReadable: config.secretReadable,
    hostPreset: config.hostPreset,
    participantPreset: config.participantPreset,
    sharedPreset: config.source !== 'missing' && config.hostPreset === config.participantPreset,
  }
}

export async function testRealtimeKitConnection(config: RealtimeKitRuntimeConfig): Promise<RealtimeKitConnectionTestResult> {
  if (!realtimekitConfigured(config)) throw new Error('RealtimeKit credentials missing')
  return testRealtimeKitApp(config, config)
}
