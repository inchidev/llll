import { z } from 'zod'
import { cloudflareGrantSchema, refreshCloudflareGrant, type CloudflareGrant } from '../../shared/cloudflare-oauth'
import { decryptSecret, encryptSecret, type EncryptedSecret } from '../../shared/encrypted-secret'
import { readServerSetting, sha256Hex } from '../../shared/server-settings'
import type { L4Env } from '../../workers/env'
import { authSecret } from './auth-config'
import { fail } from './cf'

/**
 * Cloudflare access the Owner chose to keep on this Server, so updates and
 * infrastructure changes run here instead of through the official installer.
 * It is either the installer's OAuth grant (refreshed here) or an API token the
 * Owner pasted. It is encrypted with this Server's AUTH_SECRET and never
 * leaves the backend; settings only ever show its kind, account and date.
 */
export const CLOUDFLARE_ACCESS_KEY = 'cloudflare.access'
/** The installer writes only this hash over D1; the matching token is used once. */
export const CLOUDFLARE_HANDOFF_KEY = 'cloudflare.access.handoff'
const scope = 'cloudflare-account'
const API = 'https://api.cloudflare.com/client/v4'

export type CloudflareAccess = { kind: 'oauth'; grant: CloudflareGrant; accountId: string; connectedAt: string }
  | { kind: 'token'; token: string; accountId: string; connectedAt: string }
export type CloudflareAccessStatus = { connected: false } | { connected: true; kind: CloudflareAccess['kind']; accountId: string; connectedAt: string }

type Stored = { value: string; access: CloudflareAccess }
async function load(env: L4Env): Promise<Stored | null> {
  const value = await readServerSetting(env.DB, CLOUDFLARE_ACCESS_KEY)
  if (!value) return null
  try { return { value, access: JSON.parse(await decryptSecret(authSecret(env), scope, JSON.parse(value) as EncryptedSecret)) as CloudflareAccess } }
  catch { return null }
}
async function seal(env: L4Env, access: CloudflareAccess) {
  return JSON.stringify(await encryptSecret(authSecret(env), scope, JSON.stringify(access)))
}

export async function cloudflareAccessStatus(env: L4Env): Promise<CloudflareAccessStatus> {
  const stored = await load(env)
  return stored ? { connected: true, kind: stored.access.kind, accountId: stored.access.accountId, connectedAt: stored.access.connectedAt } : { connected: false }
}

/** The access must reach this Server's own account; a token for another account is refused. */
async function assertAccount(accessToken: string, accountId: string, transport: typeof fetch) {
  const response = await transport(`${API}/accounts/${encodeURIComponent(accountId)}`, { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(15000) })
  await response.body?.cancel()
  if (response.status === 401 || response.status === 403) fail(400, 'cloudflare_access_denied', 'This Cloudflare access cannot reach the account this Server runs in')
  if (!response.ok) fail(502, 'cloudflare_unavailable', 'Cloudflare could not be reached. Try again.')
}

async function store(env: L4Env, access: CloudflareAccess, previous: string | null) {
  const sealed = await seal(env, access), now = new Date().toISOString()
  const written = previous === null
    ? await env.DB.prepare('INSERT INTO server_settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at RETURNING key').bind(CLOUDFLARE_ACCESS_KEY, sealed, now).first()
    // Conditional so two refreshes never overwrite a newer rotated grant with an older one.
    : await env.DB.prepare('UPDATE server_settings SET value=?,updated_at=? WHERE key=? AND value=? RETURNING key').bind(sealed, now, CLOUDFLARE_ACCESS_KEY, previous).first()
  return Boolean(written)
}

export async function saveCloudflareToken(env: L4Env, accountId: string, token: string, transport: typeof fetch = fetch) {
  await assertAccount(token, accountId, transport)
  await store(env, { kind: 'token', token, accountId, connectedAt: new Date().toISOString() }, null)
}

/** Accept the installer's grant with a single-use handoff token it registered over D1. */
export async function acceptCloudflareHandoff(env: L4Env, handoffToken: string, input: unknown, transport: typeof fetch = fetch) {
  const parsed = z.object({ grant: cloudflareGrantSchema, accountId: z.string().regex(/^[a-f0-9]{32}$/u) }).safeParse(input)
  if (!parsed.success) fail(400, 'cloudflare_handoff_invalid', 'The Cloudflare handoff is incomplete')
  const { grant, accountId } = parsed.data
  if (accountId !== (env.ACCOUNT_ID?.trim() || env.LLLL_ACCOUNT_ID?.trim())) fail(400, 'cloudflare_account_mismatch', 'This grant is for another Cloudflare account')
  const expected = await readServerSetting(env.DB, CLOUDFLARE_HANDOFF_KEY)
  const [hash, expires] = (expected ?? '').split(':')
  if (!hash || !/^[a-f0-9]{64}$/u.test(handoffToken) || Number(expires) < Date.now() || await sha256Hex(handoffToken) !== hash) fail(403, 'cloudflare_handoff_denied', 'This Cloudflare handoff is invalid or expired')
  // Consume the capability before anything else can use it.
  const consumed = await env.DB.prepare('DELETE FROM server_settings WHERE key=? AND value=? RETURNING key').bind(CLOUDFLARE_HANDOFF_KEY, expected).first()
  if (!consumed) fail(403, 'cloudflare_handoff_denied', 'This Cloudflare handoff was already used')
  await assertAccount(grant.accessToken, accountId, transport)
  await store(env, { kind: 'oauth', grant, accountId, connectedAt: new Date().toISOString() }, null)
}

export async function disconnectCloudflareAccess(env: L4Env) {
  await env.DB.prepare('DELETE FROM server_settings WHERE key IN (?,?)').bind(CLOUDFLARE_ACCESS_KEY, CLOUDFLARE_HANDOFF_KEY).run()
}

/** A usable Cloudflare API bearer token, refreshing and re-sealing a rotated OAuth grant. */
export async function cloudflareAccessToken(env: L4Env, refresh: typeof refreshCloudflareGrant = refreshCloudflareGrant, options: { force?: boolean } = {}): Promise<{ token: string; accountId: string }> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const stored = await load(env)
    if (!stored) fail(409, 'cloudflare_access_missing', 'Connect Cloudflare to this Server first')
    const access = stored.access
    if (access.kind === 'token') return { token: access.token, accountId: access.accountId }
    if (!options.force && access.grant.expiresAt - Date.now() > 120_000) return { token: access.grant.accessToken, accountId: access.accountId }
    let grant: CloudflareGrant
    try { grant = await refresh(access.grant) }
    catch { fail(409, 'cloudflare_access_expired', 'Cloudflare access on this Server expired. Reconnect Cloudflare.') }
    if (await store(env, { ...access, grant }, stored.value)) return { token: grant.accessToken, accountId: access.accountId }
    // Another request refreshed first; use its newer grant.
  }
  fail(409, 'cloudflare_access_busy', 'Cloudflare access is being renewed. Try again.')
}

/**
 * Renew a kept OAuth grant from the weekly cron, so a Server that changes
 * nothing for months still holds a live refresh token when it next updates.
 */
export async function renewCloudflareAccess(env: L4Env, refresh: typeof refreshCloudflareGrant = refreshCloudflareGrant) {
  const status = await cloudflareAccessStatus(env)
  if (!status.connected || status.kind !== 'oauth') return false
  await cloudflareAccessToken(env, refresh, { force: true })
  return true
}
