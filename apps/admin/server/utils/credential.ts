import {
  ADMIN_OAUTH_RELAY,
  ADMIN_OAUTH_SCOPES,
  adminRelayState,
  authorizationUrl,
  LLLL_OAUTH_CLIENT_ID,
  exchangeOAuthCode,
} from '@llll/admin-core'
import type { AdminEnv } from '../env'
import type { AdminCoordinator } from '../coordinator'
import { audit, ensureSchema, nowIso } from './db'
import { fail } from './http'
import { encryptSecret, randomToken } from './secrets'

const SECRET_SCOPE = 'cloudflare-credential'
const ACCESS_SCOPE = 'cloudflare-access-token'

export type CredentialStatus = {
  connected: boolean
  kind: 'oauth' | 'token' | null
  problem: string | null
  updatedAt: string | null
  /** A refresh token handed over at deploy that the Admin has not used yet. */
  pendingHandover: boolean
}

function coordinator(env: AdminEnv) {
  return env.COORDINATOR.get(env.COORDINATOR.idFromName('main')) as unknown as DurableObjectStub<AdminCoordinator>
}

/** A current access token for this account. Throws with a reconnect message when the credential stopped working. */
export async function cloudflareToken(env: AdminEnv): Promise<string> {
  try {
    return await coordinator(env).accessToken()
  }
  catch (error) {
    fail(409, error instanceof Error ? error.message : 'Connect Cloudflare in the L4 Admin')
  }
}

export async function credentialStatus(env: AdminEnv): Promise<CredentialStatus> {
  await ensureSchema(env.ADMIN_DB)
  const row = await env.ADMIN_DB.prepare('SELECT kind, problem, updated_at AS updatedAt FROM credential WHERE id = ?')
    .bind('main').first<{ kind: 'oauth' | 'token', problem: string | null, updatedAt: string }>()
  return {
    connected: Boolean(row) && !row?.problem,
    kind: row?.kind ?? null,
    problem: row?.problem ?? null,
    updatedAt: row?.updatedAt ?? null,
    pendingHandover: !row && Boolean(env.CLOUDFLARE_OAUTH_REFRESH_TOKEN),
  }
}

async function replaceCredential(env: AdminEnv, input: { kind: 'oauth' | 'token', secret: string, accessToken?: string, expiresAt?: number, scopes?: string }) {
  await ensureSchema(env.ADMIN_DB)
  await env.ADMIN_DB.prepare(
    `INSERT INTO credential (id, kind, secret_encrypted, access_encrypted, access_expires_at, scopes, problem, updated_at)
     VALUES ('main', ?, ?, ?, ?, ?, NULL, ?)
     ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, secret_encrypted = excluded.secret_encrypted,
       access_encrypted = excluded.access_encrypted, access_expires_at = excluded.access_expires_at,
       scopes = excluded.scopes, problem = NULL, updated_at = excluded.updated_at`,
  ).bind(
    input.kind,
    await encryptSecret(env.ADMIN_SECRET, SECRET_SCOPE, input.secret),
    input.accessToken ? await encryptSecret(env.ADMIN_SECRET, ACCESS_SCOPE, input.accessToken) : null,
    input.expiresAt ?? null,
    input.scopes ?? '',
    nowIso(),
  ).run()
  await coordinator(env).reset()
}

/** Check that a token reaches this Admin's account before storing it. */
async function assertAccountAccess(env: AdminEnv, token: string) {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  })
  if (!response.ok) fail(400, 'Cloudflare refused this token for this account. Give it access to the account the Admin runs in.')
}

export async function usePastedToken(env: AdminEnv, token: string) {
  const value = token.trim()
  if (value.length < 20 || value.length > 4000) fail(400, 'Paste a Cloudflare API token')
  await assertAccountAccess(env, value)
  await replaceCredential(env, { kind: 'token', secret: value })
  await audit(env.ADMIN_DB, 'credential.token', env.CLOUDFLARE_ACCOUNT_ID)
}

/**
 * Start a reconnect. Cloudflare returns to llll.gg, which only forwards
 * the code here; the PKCE verifier never leaves the Admin.
 */
export async function startReconnect(env: AdminEnv, adminOrigin: string): Promise<string> {
  await ensureSchema(env.ADMIN_DB)
  const nonce = randomToken(24)
  const verifier = randomToken(48)
  await env.ADMIN_DB.batch([
    env.ADMIN_DB.prepare(`DELETE FROM oauth_states WHERE created_at < ?`).bind(new Date(Date.now() - 15 * 60_000).toISOString()),
    env.ADMIN_DB.prepare('INSERT INTO oauth_states (nonce, verifier, created_at) VALUES (?, ?, ?)').bind(nonce, verifier, nowIso()),
  ])
  return authorizationUrl({
    clientId: env.CLOUDFLARE_OAUTH_CLIENT_ID || LLLL_OAUTH_CLIENT_ID,
    redirectUri: ADMIN_OAUTH_RELAY,
    scopes: ADMIN_OAUTH_SCOPES,
    state: adminRelayState(new URL(adminOrigin).hostname, nonce),
    verifier,
  })
}

export async function finishReconnect(env: AdminEnv, input: { code: string, nonce: string }) {
  await ensureSchema(env.ADMIN_DB)
  const state = await env.ADMIN_DB.prepare('SELECT verifier, created_at AS createdAt FROM oauth_states WHERE nonce = ?')
    .bind(input.nonce).first<{ verifier: string, createdAt: string }>()
  await env.ADMIN_DB.prepare('DELETE FROM oauth_states WHERE nonce = ?').bind(input.nonce).run()
  if (!state || Date.parse(state.createdAt) < Date.now() - 15 * 60_000) fail(400, 'This Cloudflare connection link expired. Start again from the Admin.')
  const tokens = await exchangeOAuthCode({
    code: input.code,
    verifier: state.verifier,
    clientId: env.CLOUDFLARE_OAUTH_CLIENT_ID || LLLL_OAUTH_CLIENT_ID,
    redirectUri: ADMIN_OAUTH_RELAY,
  }).catch(error => fail(400, error instanceof Error ? error.message : 'Cloudflare did not complete the connection'))
  await assertAccountAccess(env, tokens.accessToken)
  await replaceCredential(env, { kind: 'oauth', secret: tokens.refreshToken, accessToken: tokens.accessToken, expiresAt: tokens.expiresAt, scopes: tokens.scopes })
  await audit(env.ADMIN_DB, 'credential.oauth', env.CLOUDFLARE_ACCOUNT_ID)
}
