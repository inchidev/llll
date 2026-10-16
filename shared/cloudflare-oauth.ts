import { z } from 'zod'

export const CLOUDFLARE_AUTH_URL = 'https://dash.cloudflare.com/oauth2/auth'
export const CLOUDFLARE_TOKEN_URL = 'https://dash.cloudflare.com/oauth2/token'
export const CLOUDFLARE_SCOPES = 'offline_access account-settings.read memberships.read workers-scripts.content_read workers-scripts.edit d1.read d1.write workers-kv-storage.read workers-kv-storage.write workers-r2.read workers-r2.write'
export const cloudflareGrantSchema = z.object({ accessToken: z.string().min(1), refreshToken: z.string().min(1), expiresAt: z.number(), clientId: z.string().min(1) })
export type CloudflareGrant = z.infer<typeof cloudflareGrantSchema>

export async function oauthGrant(body: URLSearchParams, clientId: string, fallbackRefreshToken = ''): Promise<CloudflareGrant> {
  body.set('client_id', clientId)
  const response = await fetch(CLOUDFLARE_TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body, signal: AbortSignal.timeout(20000) })
  if (!response.ok) throw new Error('Cloudflare authorization expired. Reconnect Cloudflare.')
  const token = z.object({ access_token: z.string(), refresh_token: z.string().optional(), expires_in: z.number().positive() }).parse(await response.json())
  if (!token.refresh_token && !fallbackRefreshToken) throw new Error('Cloudflare did not grant offline access. Reconnect Cloudflare.')
  return { accessToken: token.access_token, refreshToken: token.refresh_token || fallbackRefreshToken, expiresAt: Date.now() + token.expires_in * 1000, clientId }
}

export async function refreshCloudflareGrant(grant: CloudflareGrant) {
  return oauthGrant(new URLSearchParams({ grant_type: 'refresh_token', refresh_token: grant.refreshToken }), grant.clientId, grant.refreshToken)
}

export function randomCode() {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(48)))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}
export async function pkceChallenge(verifier: string) {
  return btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}
