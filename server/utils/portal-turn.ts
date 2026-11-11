import { decryptSecret, encryptSecret, type EncryptedSecret } from '../../shared/encrypted-secret'
import { readServerSetting } from '../../shared/server-settings'
import { isOperatorManaged } from '../../shared/server-runtime'
import type { L4Env } from '../../workers/env'
import { authSecret } from './auth-config'
import { cloudflareAccessStatus, cloudflareAccessToken } from './cloudflare-account-access'

/**
 * TURN for Portals (ADR 0014, stage 2). When no direct path exists between the host's Mac and a guest, the picture
 * goes through Cloudflare's TURN relay on the operator's own Cloudflare account. The Server keeps one TURN key and
 * gives both sides short-lived credentials minted from it; the key itself never leaves the Server.
 */
export type TurnKey = { keyId: string, apiToken: string }
export type IceServer = { urls: string[], username?: string, credential?: string }

const SETTING = 'portal.turn-key'
const SCOPE = 'portal-turn-key'
const API = 'https://api.cloudflare.com/client/v4'
const TURN = 'https://rtc.live.cloudflare.com/v1/turn/keys'

type Transport = typeof fetch

/** The key from the deployment's variables, the one saved here, or a new one made with the Server's kept Cloudflare access. */
export async function portalTurnKey(env: L4Env, transport: Transport = fetch): Promise<TurnKey | null> {
  const keyId = env.REALTIME_TURN_KEY_ID?.trim()
  const apiToken = env.REALTIME_TURN_KEY_API_TOKEN?.trim()
  if (keyId && apiToken) return { keyId, apiToken }
  const saved = await savedKey(env)
  if (saved) return saved
  // Only a Server in the operator's own Cloudflare account can make one; L4 Cloud and celld bring theirs in variables.
  if (isOperatorManaged(env)) return null
  if (!(await cloudflareAccessStatus(env)).connected) return null
  return provisionKey(env, transport)
}

async function savedKey(env: L4Env): Promise<TurnKey | null> {
  const value = await readServerSetting(env.DB, SETTING)
  if (!value) return null
  try { return JSON.parse(await decryptSecret(authSecret(env), SCOPE, JSON.parse(value) as EncryptedSecret)) as TurnKey }
  catch { return null }
}

/** Make one TURN key in the Server's account and keep it. Two Portals racing keep whichever was saved first. */
async function provisionKey(env: L4Env, transport: Transport): Promise<TurnKey | null> {
  const access = await cloudflareAccessToken(env)
  const response = await transport(`${API}/accounts/${encodeURIComponent(access.accountId)}/calls/turn_keys`, {
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
  const keyId = [result.uid, result.key_id, result.id].find(value => typeof value === 'string') as string | undefined
  const apiToken = [result.key, result.token, result.api_token].find(value => typeof value === 'string') as string | undefined
  if (!keyId || !apiToken) return null
  const sealed = JSON.stringify(await encryptSecret(authSecret(env), SCOPE, JSON.stringify({ keyId, apiToken } satisfies TurnKey)))
  await env.DB.prepare('INSERT INTO server_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO NOTHING')
    .bind(SETTING, sealed, new Date().toISOString()).run()
  return savedKey(env)
}

/**
 * Credentials for one host connection, valid for `ttlSeconds`. Port 53 is left out: browsers block it and it only
 * costs a timeout. Answers null when the Server has no TURN, so the two sides keep STUN.
 */
export async function portalIceServers(env: L4Env, ttlSeconds: number, transport: Transport = fetch): Promise<IceServer[] | null> {
  const key = await portalTurnKey(env, transport)
  if (!key) return null
  const response = await transport(`${TURN}/${encodeURIComponent(key.keyId)}/credentials/generate-ice-servers`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${key.apiToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ttl: Math.max(60, Math.floor(ttlSeconds)) }),
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) {
    await response.body?.cancel()
    return null
  }
  const body = await response.json().catch(() => null) as { iceServers?: Array<{ urls?: string | string[], username?: string, credential?: string }> } | null
  const servers = (body?.iceServers ?? []).map((server) => {
    const urls = (Array.isArray(server.urls) ? server.urls : server.urls ? [server.urls] : []).filter(url => !/:53(?:\?|$)/u.test(url))
    return { urls, ...(server.username ? { username: server.username } : {}), ...(server.credential ? { credential: server.credential } : {}) }
  }).filter(server => server.urls.length > 0)
  return servers.length ? servers : null
}
