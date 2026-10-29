import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose'
import { z } from 'zod'
import { readLimitedStream } from '../../workers/inbound-email-signature'
import { decryptSecret, encryptSecret } from '../../shared/encrypted-secret'
import { readServerSetting, writeServerSetting } from '../../shared/server-settings'
import type { L4Env } from '../../workers/env'
import { agentProviderKey, agentProviderScope, chatGPTUsableBy, loadAgentProvider, type ChatGPTCredentials } from './agent-providers'
import { discoverAgentModels } from './agent-provider-models'
import { fail } from './cf'
import { writeAudit } from './messages'
const issuer = 'https://auth.openai.com'
const resource = 'https://api.openai.com/v1'
const jwks = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`))
const random = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
const scope = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct'
type Pending = { connectionId: string; actorId: string; state: string; nonce: string; verifier: string; redirectUri: string; returnOrigin: string; expires: number; clientId?: string; subject?: string; credentialVersion?: string }
const pendingKey = (state: string) => `agents.oauth.${state}`
// Plaintext outcome of one attempt, so a repeated Finish reports what happened instead of an empty state.
const outcomeKey = (state: string) => `agents.oauth.${state}.outcome`
type Outcome = { status: 'exchanging' | 'failed' | 'done'; message?: string; connectionId?: string; returnOrigin?: string }
async function priorOutcome(env: L4Env, state: string) {
  if (!/^[\w-]{43}$/u.test(state)) return null
  const value = await readServerSetting(env.DB, outcomeKey(state))
  return value ? JSON.parse(value) as Outcome : null
}
const errorText = (error: unknown) => (error as { data?: { error?: { message?: string } } })?.data?.error?.message ?? 'ChatGPT sign-in could not be completed'
export async function beginChatGPT(env: L4Env, connectionId: string, actorId: string, origin: string, local: boolean) {
  if (!env.AUTH_SECRET || env.AUTH_SECRET.length < 32) fail(503, 'secret_unavailable', 'Server encryption is unavailable')
  const provider = await loadAgentProvider(env, connectionId)
  if (provider?.kind !== 'chatgpt') fail(404, 'not_found', 'ChatGPT connection not found')
  if (provider.connectedBy && provider.connectedBy !== actorId) fail(403, 'forbidden', 'Reconnect using the member who connected this account')
  const previous = provider.secret ? JSON.parse(await decryptSecret(env.AUTH_SECRET, agentProviderScope(connectionId), provider.secret)) as ChatGPTCredentials : null
  let host = await readServerSetting(env.DB, 'agents.chatgpt.host')
  if (!host) {
    await env.DB.prepare("INSERT OR IGNORE INTO server_settings(key,value,updated_at) VALUES ('agents.chatgpt.host',?,?)").bind(`urn:uuid:${crypto.randomUUID()}`, new Date().toISOString()).run()
    host = await readServerSetting(env.DB, 'agents.chatgpt.host')
  }
  const state = random(), nonce = random(), verifier = random()
  const redirectUri = local ? `http://127.0.0.1:${new URL(origin).port || '80'}/api/agent-auth/callback` : 'http://127.0.0.1:1455/auth/callback'
  const pending: Pending = { connectionId, actorId, state, nonce, verifier, redirectUri, returnOrigin: origin, expires: Date.now() + 600000, clientId: previous?.clientId, subject: previous?.subject, credentialVersion: provider.secret?.ciphertext }
  await env.DB.prepare("DELETE FROM server_settings WHERE key LIKE 'agents.oauth.%' AND updated_at < ?").bind(new Date(Date.now() - 600000).toISOString()).run()
  await writeServerSetting(env.DB, pendingKey(state), JSON.stringify(await encryptSecret(env.AUTH_SECRET, pendingKey(state), JSON.stringify(pending))))
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  const challenge = btoa(String.fromCharCode(...new Uint8Array(digest))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
  const url = new URL(`${issuer}/api/accounts/authorize`)
  url.search = new URLSearchParams({ client_id: previous?.clientId ?? 'dynamic_agent_client', ...(!previous ? { agent_name_hint: 'L4' } : { id_token_hint: previous.idToken }), ext_agent_host_id: host!, response_type: 'code', redirect_uri: redirectUri, scope, resource, state, nonce, code_challenge_method: 'S256', code_challenge: challenge }).toString()
  return { state, authorizationUrl: url.toString(), redirectUri, expiresAt: pending.expires }
}
export async function loadChatGPTAttempt(env: L4Env, state: string): Promise<Pending> {
  if (!/^[\w-]{43}$/u.test(state)) fail(400, 'invalid_state', 'Sign-in attempt is invalid')
  const value = await readServerSetting(env.DB, pendingKey(state))
  if (!value || !env.AUTH_SECRET) fail(400, 'invalid_state', 'Sign-in attempt expired or was already used')
  const pending = JSON.parse(await decryptSecret(env.AUTH_SECRET, pendingKey(state), JSON.parse(value))) as Pending
  if (pending.expires < Date.now()) fail(400, 'expired', 'Sign-in expired. Try again.')
  return pending
}
const tokensSchema = z.object({ access_token: z.string().min(1), refresh_token: z.string().min(1).optional(), id_token: z.string().min(1).optional(), expires_in: z.number().positive(), scope: z.string().optional() })
async function tokenRequest(body: URLSearchParams) {
  const response = await fetch(`${issuer}/api/accounts/oauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body, signal: AbortSignal.timeout(20000), redirect: 'manual' })
  if (!response.ok) fail(409, 'chatgpt_auth_failed', 'ChatGPT authorization failed. Connect again.')
  const received = await readLimitedStream(response.body, 128000)
  if (!received.ok) fail(502, 'invalid_tokens', 'ChatGPT token response exceeded the limit')
  return tokensSchema.parse(JSON.parse(new TextDecoder().decode(received.bytes)))
}
export async function completeChatGPT(env: L4Env, callback: URL, keySet: JWTVerifyGetKey = jwks) {
  const state = callback.searchParams.get('state') ?? ''
  const prior = await priorOutcome(env, state)
  if (prior?.status === 'done') return { returnOrigin: prior.returnOrigin!, connectionId: prior.connectionId! }
  if (prior?.status === 'failed') fail(409, 'sign_in_failed', `${prior.message} Select Continue with ChatGPT to start again.`)
  if (prior?.status === 'exchanging') fail(409, 'sign_in_in_progress', 'This sign-in is still finishing. Wait a moment and check the connection.')
  const pending = await loadChatGPTAttempt(env, state)
  if (`${callback.origin}${callback.pathname}` !== pending.redirectUri) fail(400, 'invalid_callback', 'Callback does not match this sign-in')
  const owner = await env.DB.prepare('SELECT owner_id as id,id as serverId FROM server LIMIT 1').first<{ id: string; serverId: string }>()
  if (owner?.id !== pending.actorId) fail(403, 'forbidden', 'Only the current Server owner can finish this connection')
  const clientId = callback.searchParams.get('client_id') ?? pending.clientId
  if (!clientId || clientId === 'dynamic_agent_client' || (pending.clientId && clientId !== pending.clientId)) fail(400, 'invalid_client', 'ChatGPT registration is incomplete')
  // Claiming the outcome is the replay guard; the attempt stays readable until it settles.
  const claimed = await env.DB.prepare("INSERT INTO server_settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO NOTHING RETURNING key")
    .bind(outcomeKey(state), JSON.stringify({ status: 'exchanging' } satisfies Outcome), new Date().toISOString()).first()
  if (!claimed) fail(409, 'already_used', 'This sign-in was already submitted. Check the connection before starting again.')
  const settle = (outcome: Outcome) => env.DB.batch([
    env.DB.prepare('UPDATE server_settings SET value=?,updated_at=? WHERE key=?').bind(JSON.stringify(outcome), new Date().toISOString(), outcomeKey(state)),
    env.DB.prepare('DELETE FROM server_settings WHERE key=?').bind(pendingKey(state)),
  ])
  try {
    const result = await exchangeChatGPT(env, callback, pending, owner, clientId, keySet)
    await settle({ status: 'done', ...result })
    return result
  } catch (error) {
    await settle({ status: 'failed', message: errorText(error) })
    throw error
  }
}

async function exchangeChatGPT(env: L4Env, callback: URL, pending: Pending, owner: { id: string; serverId: string }, clientId: string, keySet: JWTVerifyGetKey) {
  if (callback.searchParams.has('error')) fail(400, 'access_denied', 'ChatGPT sign-in was declined')
  const code = callback.searchParams.get('code')
  if (!code) fail(400, 'code_required', 'ChatGPT did not return an authorization code')
  const tokens = await tokenRequest(new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId, code, code_verifier: pending.verifier, redirect_uri: pending.redirectUri, resource }))
  if (!tokens.id_token || !tokens.refresh_token) fail(400, 'invalid_tokens', 'ChatGPT did not return renewable credentials')
  const { payload } = await jwtVerify(tokens.id_token, keySet, { issuer, audience: clientId, requiredClaims: ['sub', 'exp', 'nonce'] })
  if (payload.nonce !== pending.nonce || (pending.subject && pending.subject !== payload.sub)) fail(400, 'identity_mismatch', 'ChatGPT account does not match this connection')
  if (!tokens.scope?.split(' ').includes('chatgpt.tokens.use.direct')) fail(403, 'plan_permission', 'ChatGPT plan usage was not authorized. Connect again and allow plan usage.')
  const credentials: ChatGPTCredentials = { accessToken: tokens.access_token, refreshToken: tokens.refresh_token, idToken: tokens.id_token, expiresAt: Date.now() + tokens.expires_in * 1000, clientId, subject: payload.sub!, email: typeof payload.email === 'string' ? payload.email : payload.sub!, scope: tokens.scope }
  const original = await readServerSetting(env.DB, agentProviderKey(pending.connectionId))
  const current = await loadAgentProvider(env, pending.connectionId)
  if (!current || current.kind !== 'chatgpt' || current.secret?.ciphertext !== pending.credentialVersion || (current.connectedBy && current.connectedBy !== pending.actorId)) fail(409, 'connection_changed', 'Connection changed during sign-in')
  // A real account-specific catalog is required; a bundled catalog is not entitlement evidence.
  const models = await discoverAgentModels('chatgpt', credentials.accessToken)
  if (!models.length) fail(409, 'no_models', 'This ChatGPT account has no available models')
  const selected = current.models.filter(m => models.some(option => option.id === m.id))
  const value = JSON.stringify({ ...current, enabled: true, connectedBy: pending.actorId, account: credentials.email, connectedAt: new Date().toISOString(), models: selected.length ? selected : [models[0]!], secret: await encryptSecret(env.AUTH_SECRET!, agentProviderScope(pending.connectionId), JSON.stringify(credentials)) })
  const updated = await env.DB.prepare('UPDATE server_settings SET value=?,updated_at=? WHERE key=? AND value=? RETURNING key').bind(value, new Date().toISOString(), agentProviderKey(pending.connectionId), original).first()
  if (!updated) fail(409, 'connection_changed', 'Connection changed during sign-in. Connect again.')
  await writeAudit(env, { serverId: owner.serverId, actorId: pending.actorId, action: 'agent.provider.connect', targetType: 'agent_provider', targetId: pending.connectionId, meta: { kind: 'chatgpt' } })
  return { returnOrigin: pending.returnOrigin, connectionId: pending.connectionId }
}
export async function chatGPTAccessToken(env: L4Env, connectionId: string, actorId: string): Promise<string> {
  let provider = await loadAgentProvider(env, connectionId)
  if (!provider?.enabled || provider.kind !== 'chatgpt' || !provider.secret || !chatGPTUsableBy(provider, actorId)) fail(403, 'personal_provider', 'This ChatGPT account is not available to this member')
  let credentials = JSON.parse(await decryptSecret(env.AUTH_SECRET!, agentProviderScope(connectionId), provider.secret)) as ChatGPTCredentials
  if (credentials.expiresAt > Date.now() + 60000) return credentials.accessToken
  // A database lease serializes refresh across Workers and Durable Objects, including token rotation.
  const lockKey = `agents.refresh.${connectionId}`
  const lease = crypto.randomUUID()
  const locked = await env.DB.prepare(`INSERT INTO server_settings(key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at WHERE server_settings.updated_at<? RETURNING key`)
    .bind(lockKey, lease, new Date().toISOString(), new Date(Date.now() - 30000).toISOString()).first()
  if (!locked) fail(503, 'refresh_busy', 'ChatGPT is renewing this connection. Try again shortly.')
  try {
    const original = await readServerSetting(env.DB, agentProviderKey(connectionId))
    provider = await loadAgentProvider(env, connectionId)
    if (!provider?.enabled || !provider.secret || !chatGPTUsableBy(provider, actorId)) fail(403, 'connection_changed', 'ChatGPT connection is no longer available')
    credentials = JSON.parse(await decryptSecret(env.AUTH_SECRET!, agentProviderScope(connectionId), provider.secret)) as ChatGPTCredentials
    if (credentials.expiresAt > Date.now() + 60000) return credentials.accessToken
    const tokens = await tokenRequest(new URLSearchParams({ grant_type: 'refresh_token', client_id: credentials.clientId, refresh_token: credentials.refreshToken, resource }))
    const renewed = { ...credentials, accessToken: tokens.access_token, refreshToken: tokens.refresh_token ?? credentials.refreshToken, expiresAt: Date.now() + tokens.expires_in * 1000, scope: tokens.scope ?? credentials.scope }
    if (!renewed.scope.split(' ').includes('chatgpt.tokens.use.direct')) fail(403, 'plan_permission', 'Reconnect ChatGPT and allow plan usage')
    const saved = JSON.stringify({ ...provider, secret: await encryptSecret(env.AUTH_SECRET!, agentProviderScope(connectionId), JSON.stringify(renewed)) })
    const updated = await env.DB.prepare('UPDATE server_settings SET value=?,updated_at=? WHERE key=? AND value=? RETURNING key').bind(saved, new Date().toISOString(), agentProviderKey(connectionId), original).first()
    if (!updated) fail(409, 'connection_changed', 'ChatGPT connection changed during renewal')
    return renewed.accessToken
  } finally { await env.DB.prepare('DELETE FROM server_settings WHERE key=? AND value=?').bind(lockKey, lease).run() }
}
