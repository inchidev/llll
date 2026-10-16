/**
 * RealtimeKit over its REST API, shared by the workspace (a pasted token) and
 * the installation deployment library (the operator credential). It has no imports so both
 * bundles can use it directly.
 */

/** Presets L4 provisions in the app it connects. Hosts can moderate a Live room; participants cannot. */
export const LLLL_HOST_PRESET = 'llll_live_host'
export const LLLL_PARTICIPANT_PRESET = 'llll_live_participant'

const CLOUDFLARE_API = 'https://api.cloudflare.com/client/v4'

/** One RealtimeKit app and the credential that may use it. */
export type RealtimeKitApp = {
  accountId: string
  appId: string
  apiToken: string
}

export class RealtimeKitHttpError extends Error {
  constructor(readonly status: number) {
    super(`RealtimeKit HTTP ${status}`)
  }
}

async function cloudflareFetch(apiToken: string, method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${CLOUDFLARE_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiToken}`,
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const json = await res.json().catch(() => ({})) as { result?: unknown, data?: unknown }
  if (!res.ok) throw new RealtimeKitHttpError(res.status)
  return json.result ?? json.data ?? json
}

function kitFetch(config: RealtimeKitApp, method: string, path: string, body?: unknown): Promise<unknown> {
  if (!config.accountId || !config.appId || !config.apiToken) throw new Error('RealtimeKit unconfigured')
  return cloudflareFetch(config.apiToken, method, `/accounts/${config.accountId}/realtime/kit/${config.appId}${path}`, body)
}

async function ignoreNotFound(request: Promise<unknown>): Promise<void> {
  try {
    await request
  }
  catch (error) {
    if (!(error instanceof RealtimeKitHttpError) || error.status !== 404) throw error
  }
}

export type RealtimeKitConnectionTestResult = { presets: string[] }

export async function testRealtimeKitApp(
  config: RealtimeKitApp,
  presets: { hostPreset: string, participantPreset: string },
): Promise<RealtimeKitConnectionTestResult> {
  if (!config.accountId || !config.appId || !config.apiToken) throw new Error('RealtimeKit credentials missing')
  const available = await listPresetNames(config.apiToken, config.accountId, config.appId)
  const required = [...new Set([presets.hostPreset, presets.participantPreset])]
  const missing = required.filter(name => !available.includes(name))
  if (missing.length) throw new Error(`RealtimeKit preset not found: ${missing.join(', ')}`)
  return { presets: available }
}

export async function createMeeting(config: RealtimeKitApp, title: string): Promise<{ id: string }> {
  const data = await kitFetch(config, 'POST', '/meetings', { title })
  const id = pickString(data, 'id')
  if (!id) throw new Error('RealtimeKit meeting create failed')
  return { id }
}

export type RealtimeKitParticipant = { id: string, token: string }

export async function addParticipant(
  config: RealtimeKitApp,
  meetingId: string,
  opts: { name: string, customId: string, preset: string },
): Promise<RealtimeKitParticipant> {
  const data = await kitFetch(config, 'POST', `/meetings/${meetingId}/participants`, {
    name: opts.name,
    preset_name: opts.preset,
    custom_participant_id: opts.customId,
  })
  const id = pickString(data, 'id')
  const token = pickString(data, 'token') ?? pickString(data, 'authToken')
  if (!id || !token) throw new Error('RealtimeKit participant token missing')
  return { id, token }
}

/**
 * Remove participants from the media session and revoke their tokens. Used when
 * someone leaves or loses access to the conversation that owns the room.
 */
export async function removeParticipants(config: RealtimeKitApp, meetingId: string, participantIds: string[]): Promise<void> {
  if (!participantIds.length) return
  await ignoreNotFound(kitFetch(config, 'POST', `/meetings/${meetingId}/active-session/kick`, { participant_ids: participantIds }))
  for (const participantId of participantIds) {
    await ignoreNotFound(kitFetch(config, 'DELETE', `/meetings/${meetingId}/participants/${participantId}`))
  }
}

export async function endMeeting(config: RealtimeKitApp, meetingId: string): Promise<void> {
  // An already-ended session has nothing left to kick, but its meeting must
  // still be made inactive so a participant cannot create another session.
  await ignoreNotFound(kitFetch(config, 'POST', `/meetings/${meetingId}/active-session/kick-all`))
  await kitFetch(config, 'PATCH', `/meetings/${meetingId}`, { status: 'INACTIVE' })
}

export type RealtimeKitAccount = { id: string, name: string }

export type RealtimeKitConnection = {
  accountId: string
  appId: string
  hostPreset: string
  participantPreset: string
}

/**
 * Turn one Cloudflare API token into a working connection: pick its account,
 * reuse or create this installation's RealtimeKit app, and provision the host
 * and participant presets. Returns the accounts to choose from when the token
 * reaches more than one and none was named.
 */
export async function connectRealtimeKit(
  apiToken: string,
  opts: { accountId?: string, appName: string },
): Promise<RealtimeKitConnection | { accounts: RealtimeKitAccount[] }> {
  const accounts = await listAccounts(apiToken)
  const account = opts.accountId
    ? accounts.find(item => item.id === opts.accountId)
    : accounts.length === 1 ? accounts[0] : undefined
  if (!account) {
    if (!accounts.length) throw new RealtimeKitHttpError(403)
    return { accounts }
  }
  const appId = await findOrCreateApp(apiToken, account.id, opts.appName)
  await ensureLivePresets(apiToken, account.id, appId)
  return {
    accountId: account.id,
    appId,
    hostPreset: LLLL_HOST_PRESET,
    participantPreset: LLLL_PARTICIPANT_PRESET,
  }
}

async function listAccounts(apiToken: string): Promise<RealtimeKitAccount[]> {
  const data = await cloudflareFetch(apiToken, 'GET', '/accounts?per_page=50')
  return listOf(data).flatMap((item) => {
    const id = pickString(item, 'id')
    return id ? [{ id, name: pickString(item, 'name') ?? id }] : []
  })
}

/** Create the host and participant presets in an app that does not have them yet. */
export async function ensureLivePresets(apiToken: string, accountId: string, appId: string): Promise<void> {
  const existing = await listPresetNames(apiToken, accountId, appId)
  for (const [name, host] of [[LLLL_HOST_PRESET, true], [LLLL_PARTICIPANT_PRESET, false]] as const) {
    if (!existing.includes(name)) {
      await cloudflareFetch(apiToken, 'POST', `/accounts/${accountId}/realtime/kit/${appId}/presets`, livePreset(name, host))
    }
  }
}

export async function findOrCreateApp(apiToken: string, accountId: string, name: string): Promise<string> {
  const apps = listOf(await cloudflareFetch(apiToken, 'GET', `/accounts/${accountId}/realtime/kit/apps`))
  const match = apps.find(app => pickString(app, 'name') === name)
  const existingId = match ? pickString(match, 'id') : null
  if (existingId) return existingId
  const created = await cloudflareFetch(apiToken, 'POST', `/accounts/${accountId}/realtime/kit/apps`, { name })
  const app = created && typeof created === 'object' && 'app' in created ? (created as { app: unknown }).app : created
  const id = pickString(app, 'id')
  if (!id) throw new Error('RealtimeKit app create failed')
  return id
}

async function listPresetNames(apiToken: string, accountId: string, appId: string): Promise<string[]> {
  const data = await cloudflareFetch(apiToken, 'GET', `/accounts/${accountId}/realtime/kit/${appId}/presets?per_page=100`)
  return listOf(data).flatMap((preset) => {
    const name = pickString(preset, 'name')
    return name ? [name] : []
  })
}

/**
 * L4 draws its own call UI and keeps chat in the conversation, so the
 * presets only decide media and moderation. Nothing records or transcribes.
 */
function livePreset(name: string, host: boolean) {
  return {
    name,
    config: {
      view_type: 'GROUP_CALL',
      max_screenshare_count: 1,
      max_video_streams: { desktop: 9, mobile: 4 },
      media: {
        video: { quality: 'hd', frame_rate: 30 },
        screenshare: { quality: 'hd', frame_rate: 5 },
      },
    },
    permissions: {
      accept_waiting_requests: host,
      can_accept_production_requests: false,
      can_change_participant_permissions: false,
      can_edit_display_name: false,
      can_livestream: false,
      can_record: false,
      can_spotlight: false,
      disable_participant_audio: host,
      disable_participant_screensharing: host,
      disable_participant_video: host,
      hidden_participant: false,
      kick_participant: host,
      pin_participant: host,
      show_participant_list: true,
      waiting_room_type: 'SKIP',
      recorder_type: 'NONE',
      transcription_enabled: false,
      chat: {
        private: { can_receive: false, can_send: false, files: false, text: false },
        public: { can_send: false, files: false, text: false },
      },
      connected_meetings: {
        can_alter_connected_meetings: false,
        can_switch_connected_meetings: false,
        can_switch_to_parent_meeting: false,
      },
      media: {
        audio: { can_produce: 'ALLOWED' },
        video: { can_produce: 'ALLOWED' },
        screenshare: { can_produce: 'ALLOWED' },
      },
      plugins: { can_close: false, can_edit_config: false, can_start: false, config: {} },
      polls: { can_create: false, can_view: false, can_vote: false },
    },
    ui: {
      design_tokens: {
        border_radius: 'rounded',
        border_width: 'thin',
        spacing_base: 4,
        theme: 'dark',
        colors: {
          brand: { 300: '#fbae5c', 400: '#f99a3a', 500: '#f6821f', 600: '#e06c0e', 700: '#b8570b' },
          background: { 600: '#393939', 700: '#2c2c2c', 800: '#1e1e1e', 900: '#1a1a1a', 1000: '#080808' },
          danger: '#ff2d2d',
          success: '#62a504',
          warning: '#ffcd07',
          text: '#eeeeee',
          text_on_brand: '#ffffff',
          video_bg: '#191919',
        },
      },
    },
  }
}

function listOf(data: unknown): unknown[] {
  if (Array.isArray(data)) return data
  if (data && typeof data === 'object' && Array.isArray((data as { data?: unknown }).data)) {
    return (data as { data: unknown[] }).data
  }
  return []
}

function pickString(data: unknown, key: string): string | null {
  if (!data || typeof data !== 'object') return null
  const rec = data as Record<string, unknown>
  if (typeof rec[key] === 'string') return rec[key]
  const inner = rec.data
  if (inner && typeof inner === 'object' && typeof (inner as Record<string, unknown>)[key] === 'string') {
    return (inner as Record<string, string>)[key]!
  }
  return null
}
