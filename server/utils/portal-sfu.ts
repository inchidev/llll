import { decryptSecret, encryptSecret, type EncryptedSecret } from '../../shared/encrypted-secret'
import { readServerSetting } from '../../shared/server-settings'
import { isOperatorManaged } from '../../shared/server-runtime'
import type { L4Env } from '../../workers/env'
import { authSecret } from './auth-config'
import { cloudflareAccessStatus, cloudflareAccessToken } from './cloudflare-account-access'

/**
 * Realtime SFU for Portals with several viewers (ADR 0014, stage 3). The host's Mac publishes its picture once to
 * the SFU and every guest subscribes; the Server makes every SFU call, and the app's secret never leaves it. The app
 * comes from the deployment's variables, or a Server in its own Cloudflare account with kept Cloudflare access makes
 * one, as it does its TURN key (portal-turn.ts).
 */
export type SfuApp = { appId: string, appToken: string }

const SETTING = 'portal.sfu-app'
const SCOPE = 'portal-sfu-app'
const API = 'https://api.cloudflare.com/client/v4'
const SFU = 'https://rtc.live.cloudflare.com/v1/apps'

type Transport = typeof fetch

/** The app from the deployment's variables, the one saved here, or a new one made with the Server's kept Cloudflare access. */
export async function portalSfuApp(env: L4Env, transport: Transport = fetch): Promise<SfuApp | null> {
  const appId = env.REALTIME_SFU_APP_ID?.trim()
  const appToken = env.REALTIME_SFU_APP_TOKEN?.trim()
  if (appId && appToken) return { appId, appToken }
  const saved = await savedApp(env)
  if (saved) return saved
  // Only a Server in the operator's own Cloudflare account can make one; L4 Cloud and celld bring theirs in variables.
  if (isOperatorManaged(env)) return null
  if (!(await cloudflareAccessStatus(env)).connected) return null
  return provisionApp(env, transport)
}

async function savedApp(env: L4Env): Promise<SfuApp | null> {
  const value = await readServerSetting(env.DB, SETTING)
  if (!value) return null
  try { return JSON.parse(await decryptSecret(authSecret(env), SCOPE, JSON.parse(value) as EncryptedSecret)) as SfuApp }
  catch { return null }
}

/** Make one SFU app in the Server's account and keep it. Two Portals racing keep whichever was saved first. */
async function provisionApp(env: L4Env, transport: Transport): Promise<SfuApp | null> {
  const access = await cloudflareAccessToken(env)
  const response = await transport(`${API}/accounts/${encodeURIComponent(access.accountId)}/calls/apps`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${access.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'L4 Portal' }),
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) {
    await response.body?.cancel()
    return null
  }
  const body = await response.json().catch(() => null) as { result?: Record<string, unknown> } | null
  const result = body?.result ?? {}
  const appId = [result.uid, result.app_id, result.id].find(value => typeof value === 'string') as string | undefined
  const appToken = [result.secret, result.token, result.app_secret].find(value => typeof value === 'string') as string | undefined
  if (!appId || !appToken) return null
  const sealed = JSON.stringify(await encryptSecret(authSecret(env), SCOPE, JSON.stringify({ appId, appToken } satisfies SfuApp)))
  await env.DB.prepare('INSERT INTO server_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO NOTHING')
    .bind(SETTING, sealed, new Date().toISOString()).run()
  return savedApp(env)
}

export type SfuDescription = { type: 'offer' | 'answer', sdp: string }
export type SfuSimulcast = { preferredRid: string, priorityOrdering?: 'none' | 'asciibetical', ridNotAvailable?: 'none' | 'asciibetical' }
export type SfuTrack = {
  location: 'local' | 'remote'
  trackName: string
  mid?: string
  sessionId?: string
  kind?: string
  simulcast?: SfuSimulcast
  errorCode?: string
  errorDescription?: string
}
export type SfuTracksResult = { requiresImmediateRenegotiation?: boolean, sessionDescription?: SfuDescription, tracks: SfuTrack[] }

/** A refusal by the SFU, or a request that did not get through. `code` is the SFU's own `errorCode` when it gave one. */
export class SfuError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'SfuError'
  }
}

/** The tracks of a result that the SFU refused one by one; an HTTP 200 does not mean every track made it. */
export function failedTracks(result: Pick<SfuTracksResult, 'tracks'>): SfuTrack[] {
  return (result.tracks ?? []).filter(track => track.errorCode)
}

/**
 * The SFU's Connection API for one app. Every call is one HTTPS request; the caller keeps the calls of one session
 * in order (the Portal's Durable Object queues them per session), because the SFU refuses a mutation that overtakes an unfinished offer and answer.
 */
export function portalSfu(app: SfuApp, transport: Transport = fetch) {
  const base = `${SFU}/${encodeURIComponent(app.appId)}`
  async function call<T>(method: 'POST' | 'PUT', path: string, body?: unknown): Promise<T> {
    let response: Response
    try {
      response = await transport(`${base}${path}`, {
        method,
        headers: { 'Authorization': `Bearer ${app.appToken}`, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(10_000),
      })
    }
    catch (error) { throw new SfuError('unreachable', `SFU unreachable: ${(error as Error)?.message ?? error}`) }
    const json = await response.json().catch(() => null) as (T & { errorCode?: string, errorDescription?: string }) | null
    if (!response.ok || !json || json.errorCode) {
      const code = json?.errorCode ?? `http_${response.status}`
      throw new SfuError(code, `SFU ${path.split('/').slice(-1)[0]}: ${json?.errorDescription ?? code}`)
    }
    return json
  }
  const session = (id: string) => `/sessions/${encodeURIComponent(id)}`
  return {
    async newSession(): Promise<string> {
      const result = await call<{ sessionId?: string }>('POST', '/sessions/new')
      if (typeof result.sessionId !== 'string' || !result.sessionId) throw new SfuError('no_session', 'SFU sessions/new gave no session')
      return result.sessionId
    },
    /** Publish local tracks with the endpoint's offer; the SFU answers. */
    publish: (sessionId: string, offer: string, tracks: Array<{ mid: string, trackName: string }>) =>
      call<SfuTracksResult>('POST', `${session(sessionId)}/tracks/new`, {
        sessionDescription: { type: 'offer', sdp: offer },
        tracks: tracks.map(track => ({ location: 'local', mid: track.mid, trackName: track.trackName })),
      }),
    /** Subscribe to remote tracks; the SFU makes an offer the endpoint answers through `renegotiate`. */
    pull: (sessionId: string, tracks: SfuTrack[]) => call<SfuTracksResult>('POST', `${session(sessionId)}/tracks/new`, { tracks }),
    renegotiate: (sessionId: string, answer: string) =>
      call<{ sessionDescription?: SfuDescription }>('PUT', `${session(sessionId)}/renegotiate`, { sessionDescription: { type: 'answer', sdp: answer } }),
    update: (sessionId: string, tracks: SfuTrack[]) => call<SfuTracksResult>('PUT', `${session(sessionId)}/tracks/update`, { tracks }),
    /** Stop forwarding without an offer from the endpoint, which may be gone already. */
    close: (sessionId: string, mids: string[]) =>
      call<SfuTracksResult>('PUT', `${session(sessionId)}/tracks/close`, { tracks: mids.map(mid => ({ mid })), force: true }),
  }
}

export type PortalSfu = ReturnType<typeof portalSfu>
