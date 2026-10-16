/**
 * The Cloudflare OAuth contract shared by llll.gg and the L4
 * Admin. The client is public (PKCE, no secret), so whoever holds a refresh
 * token can renew it with the client ID alone.
 */
export const CLOUDFLARE_AUTH_URL = 'https://dash.cloudflare.com/oauth2/auth'
export const CLOUDFLARE_TOKEN_URL = 'https://dash.cloudflare.com/oauth2/token'
export const LLLL_OAUTH_CLIENT_ID = '9681bc1d7765a0e9023b5f6a5d5c62d8'

/**
 * Where Cloudflare returns an Admin reconnect: llll.gg's registered
 * callback, which recognizes an Admin state and only forwards the code.
 */
export const ADMIN_OAUTH_RELAY = 'https://llll.gg/api/cloudflare/oauth/callback'

/** Everything an Admin needs to create, update, connect, and remove workspaces in its account. */
export const ADMIN_OAUTH_SCOPES = [
  'offline_access',
  'account-settings.read',
  'user-details.read',
  'memberships.read',
  'workers-scripts.read',
  'workers-scripts.write',
  'workers-routes.read',
  'workers-routes.write',
  'd1.read',
  'd1.write',
  'workers-kv-storage.read',
  'workers-kv-storage.write',
  'workers-r2.read',
  'workers-r2.write',
  'realtime.read',
  'realtime.write',
  'realtime.admin',
  'zone.read',
  'zone-settings.read',
  'zone-settings.write',
  'dns.read',
  'dns.write',
  'email-routing-rule.read',
  'email-routing-rule.write',
  'email-sending.read',
  'email-sending.write',
  'access.read',
  'access.write',
  'access-acct.read',
  'access-acct.write',
].join(' ')

export type OAuthTokens = {
  accessToken: string
  refreshToken: string
  expiresAt: number
  scopes: string
}

const ADMIN_HOSTNAME = /^llll-admin\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.workers\.dev$/u

/** Only a L4 Admin on its own workers.dev address may receive a relayed code. */
export function isAdminRelayTarget(hostname: string): boolean {
  return ADMIN_HOSTNAME.test(hostname.toLowerCase())
}

/** The OAuth `state` for a relayed reconnect: the Admin's hostname and its own nonce. */
export function adminRelayState(adminHostname: string, nonce: string): string {
  return `${adminHostname.toLowerCase()}~${nonce}`
}

export function parseAdminRelayState(state: string): { hostname: string, nonce: string } | null {
  const separator = state.indexOf('~')
  if (separator <= 0) return null
  const hostname = state.slice(0, separator).toLowerCase()
  const nonce = state.slice(separator + 1)
  if (!isAdminRelayTarget(hostname) || !/^[A-Za-z0-9_-]{16,128}$/u.test(nonce)) return null
  return { hostname, nonce }
}

export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  let binary = ''
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

export async function authorizationUrl(input: { clientId: string, redirectUri: string, scopes: string, state: string, verifier: string }): Promise<string> {
  const url = new URL(CLOUDFLARE_AUTH_URL)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', input.clientId)
  url.searchParams.set('redirect_uri', input.redirectUri)
  url.searchParams.set('scope', input.scopes)
  url.searchParams.set('state', input.state)
  url.searchParams.set('code_challenge', await pkceChallenge(input.verifier))
  url.searchParams.set('code_challenge_method', 'S256')
  return url.toString()
}

async function tokenRequest(body: URLSearchParams, fallbackRefreshToken = ''): Promise<OAuthTokens> {
  const response = await fetch(CLOUDFLARE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body,
  })
  const payload = await response.json().catch(() => null) as {
    access_token?: string
    refresh_token?: string
    expires_in?: number
    scope?: string
    error?: string
    error_description?: string
  } | null
  if (!response.ok || !payload?.access_token) {
    const error = new Error(payload?.error_description || payload?.error || `Cloudflare OAuth returned ${response.status}`)
    Object.assign(error, { statusCode: response.status >= 400 && response.status < 500 ? 401 : 502 })
    throw error
  }
  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token || fallbackRefreshToken,
    expiresAt: Date.now() + Math.max(60, (payload.expires_in || 3600) - 30) * 1000,
    scopes: payload.scope || '',
  }
}

export function exchangeOAuthCode(input: { code: string, verifier: string, clientId: string, redirectUri: string }): Promise<OAuthTokens> {
  return tokenRequest(new URLSearchParams({
    grant_type: 'authorization_code',
    code: input.code,
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    code_verifier: input.verifier,
  }))
}

/** Refresh tokens rotate: store the returned one; the one sent stops working. */
export function refreshOAuthGrant(input: { refreshToken: string, clientId: string }): Promise<OAuthTokens> {
  return tokenRequest(new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: input.refreshToken,
    client_id: input.clientId,
  }), input.refreshToken)
}
