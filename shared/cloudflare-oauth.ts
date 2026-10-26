import { z } from 'zod'

export const CLOUDFLARE_AUTH_URL = 'https://dash.cloudflare.com/oauth2/auth'
export const CLOUDFLARE_TOKEN_URL = 'https://dash.cloudflare.com/oauth2/token'
// Register every requested scope on the OAuth client before deploying the web
// release. Unregistered scopes fail consent with invalid_scope.
// Groups: provisioning (accounts, Workers, D1, KV, R2),
// custom domains + mail (zones, DNS, Email Routing rules, Email Sending),
// and optional provider configuration (browser rendering, containers,
// Artifacts, realtime, queues). Factory provisioning needs Artifacts Read
// and Artifacts Write (`artifacts.read`, `artifacts.write`). The encrypted
// installer grant is retained only within the
// browser's bounded deployment session, allowing another Server to be created.
// workers-scripts.admin
// is the new-model Admin role: the legacy Workers Scripts Write group
// (discoflare's workers-scripts.write) is not registered on this client, and
// provisioned workers must be created, so Editor alone dies at
// assets-upload-session with 403.
export const CLOUDFLARE_SCOPES = [
  'offline_access',
  'account-settings.read', 'memberships.read',
  'workers-scripts.content_read', 'workers-scripts.admin',
  'd1.read', 'd1.write',
  'workers-kv-storage.read', 'workers-kv-storage.write',
  'workers-r2.read', 'workers-r2.write',
  'zone.read', 'dns.read', 'dns.write',
  'email-routing-rule.read', 'email-routing-rule.write',
  'email-sending.read', 'email-sending.write',
  'browser-rendering.read',
  'containers.read', 'containers.write',
  'artifacts.read', 'artifacts.write',
  'realtime.read', 'realtime.write',
  'queues.read', 'queues.write',
].join(' ')
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
