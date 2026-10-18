import { hashPassword } from '../../../server/utils/password'
import { createStorageBackup } from '../../../shared/storage-backup'
import { uploadBackupToR2 } from '../../../shared/r2-backup'
import { verifyOAuthQueryParams } from '@better-auth/oauth-provider'
import { SignJWT, jwtVerify } from 'jose'
import { z } from 'zod'
import { version } from '../../../package.json'
import { INSTALLATION_API_VERSION } from '../../../shared/instance'
import { signInstallationIdentity, verifyInstallationIdentity } from '../../../shared/instance-identity'
import { decryptSecret, encryptSecret } from '../../../shared/encrypted-secret'
import { clientOrigins, installationAuth } from './auth'
import type { InstanceEnv } from './env'
import { provisionServer, updateServer, type ServerRow } from './provision'

import { embedNavigation } from './embed-navigation'
import { cloudflareCredentials } from './cloudflare-credentials'
import { embedOrigins } from '../../../shared/embed'

const encoder = new TextEncoder()
const idPattern = /^[a-z0-9][a-z0-9-]{0,47}$/
const setupSchema = z.object({ token: z.string().min(32).max(200), name: z.string().min(1).max(100), email: z.string().email().max(200), password: z.string().min(10).max(128) })
const createServerSchema = z.object({ name: z.string().trim().min(1).max(80) })
const registerServerSchema = createServerSchema.extend({ id: z.string().regex(idPattern), origin: z.string().url(), key: z.string().min(32).max(200), workerName: z.string().regex(idPattern).optional() })

function failure(status: number, message: string): never { throw Object.assign(new Error(message), { status }) }
function json(data: unknown, status = 200) { return Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } }) }
async function digest(value: string) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)))].map(byte => byte.toString(16).padStart(2, '0')).join('') }
function randomToken() { return [...crypto.getRandomValues(new Uint8Array(32))].map(byte => byte.toString(16).padStart(2, '0')).join('') }

async function body(request: Request): Promise<unknown> {
  if (!request.body) failure(400, 'Request body is required')
  const reader = request.body.getReader()
  let size = 0
  const chunks: Uint8Array[] = []
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    size += value.length
    if (size > 32768) { await reader.cancel(); failure(413, 'Request body is too large') }
    chunks.push(value)
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
  try { return JSON.parse(new TextDecoder().decode(bytes)) }
  catch { failure(400, 'Invalid JSON') }
}

async function ownerId(env: InstanceEnv) {
  return (await env.INSTALLATION_DB.prepare('SELECT owner_id FROM installation_meta WHERE id = 1').first<{ owner_id: string | null }>())?.owner_id || null
}

async function requireSession(request: Request, env: InstanceEnv) {
  const session = await installationAuth(env).api.getSession({ headers: request.headers })
  if (!session) failure(401, 'Sign in to this installation')
  return session
}

async function requireOwner(request: Request, env: InstanceEnv) {
  const session = await requireSession(request, env)
  if (session.user.id !== await ownerId(env)) failure(403, 'Installation owner access is required')
  return session
}

async function secretFor(env: InstanceEnv, server: ServerRow) {
  return decryptSecret(env.AUTH_SECRET, `server:${server.id}`, JSON.parse(server.secret))
}

async function serverRow(env: InstanceEnv, id: string) {
  const server = await findServerRow(env, id)
  if (!server || server.status !== 'ready') failure(404, 'Server not found or not ready')
  return server
}

async function serverRowProvisioning(env: InstanceEnv, id: string) {
  const server = await findServerRow(env, id)
  if (!server) failure(404, 'Server not found')
  return server
}

async function findServerRow(env: InstanceEnv, id: string) {
  if (!idPattern.test(id)) failure(404, 'Server not found')
  return env.INSTALLATION_DB.prepare('SELECT * FROM servers WHERE id = ?').bind(id).first<ServerRow>()
}

async function membership(env: InstanceEnv, serverId: string, userId: string) {
  return env.INSTALLATION_DB.prepare('SELECT role FROM memberships WHERE server_id = ? AND user_id = ?').bind(serverId, userId).first<{ role: 'owner' | 'member' }>()
}

function serverSummary(server: ServerRow) {
  return { id: server.id, publicId: server.public_id, name: server.name, ownerId: server.owner_id, version: server.version, status: server.status, error: server.error || undefined, origin: server.origin }
}

async function assetToken(env: InstanceEnv, serverId: string, sessionId: string) {
  return new SignJWT({ sessionId, purpose: 'asset' }).setProtectedHeader({ alg: 'HS256' }).setIssuer(env.PUBLIC_ORIGIN).setAudience(serverId).setIssuedAt().setExpirationTime('5m').sign(encoder.encode(env.AUTH_SECRET))
}

function isAssetRequest(request: Request, path: string) {
  return ['GET', 'HEAD'].includes(request.method) && /^\/api\/(?:(?:files|attachments)\/[^/]+(?:\/download)?|users\/[^/]+\/avatar|workspaces\/main\/(?:icon|agents\/[^/]+\/avatar)|task-files\/[^/]+)(?:\?|$)/.test(path)
}

async function proxyServer(request: Request, env: InstanceEnv, serverId: string, path: string) {
  const server = await serverRow(env, serverId)
  const url = new URL(request.url)
  const headers = new Headers(request.headers)
  headers.delete('x-llll-identity')
  headers.delete('cookie')
  headers.delete('authorization')
  const socket = request.headers.get('upgrade')?.toLowerCase() === 'websocket'
  if (!socket && path.startsWith('/api/')) {
    let identity: { user: { id: string; name: string; email: string }; session: { id: string } }
    const grant = url.searchParams.get('llll_asset')
    if (grant) {
      if (!isAssetRequest(request, path)) failure(403, 'Asset grants cannot authorize this operation')
      const { payload } = await jwtVerify(grant, encoder.encode(env.AUTH_SECRET), { issuer: env.PUBLIC_ORIGIN, audience: serverId, algorithms: ['HS256'] })
      if (payload.purpose !== 'asset' || typeof payload.sessionId !== 'string') failure(401, 'Invalid asset grant')
      const row = await env.INSTALLATION_DB.prepare('SELECT s.id session_id, u.id, u.name, u.email FROM auth_sessions s JOIN auth_users u ON u.id = s.user_id WHERE s.id = ? AND s.expires_at > ?').bind(payload.sessionId, Date.now()).first<{ session_id: string; id: string; name: string; email: string }>()
      if (!row) failure(401, 'Session expired')
      identity = { user: row, session: { id: row.session_id } }
    }
    else identity = await requireSession(request, env)
    const member = await membership(env, server.id, identity.user.id)
    if (!member) failure(403, 'Join this server before opening it')
    headers.set('x-llll-identity', await signInstallationIdentity({ sub: identity.user.id, name: identity.user.name, email: identity.user.email, role: member.role, sessionId: identity.session.id }, await secretFor(env, server), env.PUBLIC_ORIGIN, server.id))
  }
  if (socket && !path.startsWith('/ws/')) failure(404, 'WebSocket route not found')
  if (!socket && !path.startsWith('/api/') && !path.startsWith('/.well-known/')) failure(404, 'Server route not found')
  url.searchParams.delete('llll_asset')
  const target = new URL(path + url.search, server.origin)
  headers.set('host', target.host)
  headers.set('origin', target.origin)
  const forwarded = new Request(target, { method: request.method, headers, body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body, redirect: 'manual' })
  const binding = (env as InstanceEnv & Record<string, unknown>)[`SERVER_${server.id.toUpperCase().replaceAll('-', '_')}`]
  const response = binding && typeof binding === 'object' && 'fetch' in binding && typeof binding.fetch === 'function'
    ? await (binding as Fetcher).fetch(forwarded)
    : await fetch(forwarded)
  if (response.status === 101) return response
  const output = new Response(response.body, response)
  output.headers.delete('set-cookie')
  output.headers.set('Cache-Control', 'no-store')
  return output
}

async function audit(env: InstanceEnv, actor: string, action: string, target: string) {
  await env.INSTALLATION_DB.prepare('INSERT INTO audit (id, actor_id, action, target_id, created_at) VALUES (?, ?, ?, ?, ?)').bind(crypto.randomUUID(), actor, action, target, Date.now()).run()
}

async function validInvite(env: InstanceEnv, token: string) {
  return env.INSTALLATION_DB.prepare('SELECT server_id FROM invites WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ? AND uses < max_uses').bind(await digest(token), Date.now()).first<{ server_id: string }>()
}

async function admitInvite(env: InstanceEnv, token: string, userId: string) {
  const hash = await digest(token)
  const joined = await env.INSTALLATION_DB.prepare('SELECT m.server_id FROM memberships m JOIN invites i ON i.server_id = m.server_id WHERE i.token_hash = ? AND m.user_id = ?').bind(hash, userId).first<{ server_id: string }>()
  if (joined) return joined.server_id
  const now = Date.now()
  const results = await env.INSTALLATION_DB.batch([
    env.INSTALLATION_DB.prepare('INSERT INTO invitation_admissions (token_hash,user_id,server_id,created_at) SELECT token_hash,?,server_id,? FROM invites WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ? AND (SELECT count(*) FROM invitation_admissions WHERE token_hash = ?) < max_uses ON CONFLICT DO NOTHING RETURNING server_id').bind(userId, now, hash, now, hash),
    env.INSTALLATION_DB.prepare("INSERT INTO memberships (server_id,user_id,role,created_at) SELECT server_id,user_id,'member',created_at FROM invitation_admissions WHERE token_hash = ? AND user_id = ? ON CONFLICT DO NOTHING").bind(hash, userId),
    env.INSTALLATION_DB.prepare('UPDATE invites SET uses = (SELECT count(*) FROM invitation_admissions WHERE token_hash = ?) WHERE token_hash = ?').bind(hash, hash),
  ])
  const admitted = results[0]?.results[0] as { server_id: string } | undefined
  if (admitted) return admitted.server_id
  const existing = await env.INSTALLATION_DB.prepare('SELECT server_id FROM invitation_admissions WHERE token_hash = ? AND user_id = ?').bind(hash, userId).first<{ server_id: string }>()
  if (!existing) failure(404, 'Invitation expired or is no longer available')
  return existing.server_id
}

async function setup(request: Request, env: InstanceEnv) {
  const input = setupSchema.parse(await body(request))
  if (!env.SETUP_TOKEN || await digest(input.token) !== await digest(env.SETUP_TOKEN)) failure(403, 'Invalid owner setup claim')
  const userId = crypto.randomUUID()
  const now = Date.now()
  const password = await hashPassword(input.password)
  const email = input.email.trim().toLowerCase()
  const results = await env.INSTALLATION_DB.batch([
    env.INSTALLATION_DB.prepare('INSERT INTO auth_users (id,name,email,created_at,updated_at) SELECT ?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM installation_meta)').bind(userId, input.name, email, now, now),
    env.INSTALLATION_DB.prepare("INSERT INTO auth_accounts (id,user_id,account_id,provider_id,password,created_at,updated_at) SELECT ?,?,?,'credential',?,?,? WHERE EXISTS (SELECT 1 FROM auth_users WHERE id = ?)").bind(crypto.randomUUID(), userId, userId, password, now, now, userId),
    env.INSTALLATION_DB.prepare('INSERT INTO installation_meta (id,owner_id,created_at) SELECT 1,?,? WHERE EXISTS (SELECT 1 FROM auth_users WHERE id = ?) ON CONFLICT(id) DO NOTHING RETURNING owner_id').bind(userId, now, userId),
  ])
  if (!results[2]?.results.length) failure(409, 'Installation setup is already claimed')
  await audit(env, userId, 'installation.setup', env.INSTALLATION_ID)
  return installationAuth(env).api.signInEmail({ body: { email, password: input.password }, headers: request.headers, asResponse: true })
}

async function registerServer(request: Request, env: InstanceEnv) {
  const session = await requireOwner(request, env)
  const input = registerServerSchema.parse(await body(request))
  const origin = new URL(input.origin)
  if (origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash || (origin.protocol !== 'https:' && !(env.PUBLIC_ORIGIN.startsWith('http://localhost') && origin.hostname === 'localhost') && !(env.TRUSTED_SERVER_ORIGINS || '').split(',').includes(origin.origin))) failure(400, 'Enter an HTTPS server origin')
  const encrypted = JSON.stringify(await encryptSecret(env.AUTH_SECRET, `server:${input.id}`, input.key))
  const now = Date.now()
  await env.INSTALLATION_DB.batch([
    env.INSTALLATION_DB.prepare("INSERT INTO servers (id,name,owner_id,origin,worker_name,secret,version,status,created_at,updated_at,public_id) VALUES (?,?,?,?,?,?,?,'ready',?,?,?)").bind(input.id, input.name, session.user.id, origin.origin, input.workerName || null, encrypted, version, now, now, crypto.randomUUID()),
    env.INSTALLATION_DB.prepare("INSERT INTO memberships (server_id,user_id,role,created_at) VALUES (?,?,'owner',?)").bind(input.id, session.user.id, now),
  ])
  await audit(env, session.user.id, 'server.register', input.id)
  return json({ server: serverSummary(await serverRow(env, input.id)) }, 201)
}

async function createServer(request: Request, env: InstanceEnv) {
  const session = await requireOwner(request, env)
  const input = { ...createServerSchema.parse(await body(request)), id: crypto.randomUUID() }
  if (!env.CLOUDFLARE_API_TOKEN || !env.CLOUDFLARE_ACCOUNT_ID) failure(409, 'Connect Cloudflare provisioning or deploy and register a self-hosted server')
  const max = Math.max(1, Math.min(500, Number(env.MAX_SERVERS) || 20))
  const count = await env.INSTALLATION_DB.prepare('SELECT count(*) n FROM servers').first<{ n: number }>()
  if ((count?.n || 0) >= max) failure(409, 'This installation has reached its server limit')
  const key = randomToken()
  const now = Date.now()
  const workerName = `llll-${env.INSTALLATION_ID.slice(0, 12)}-${input.id}`.slice(0, 63)
  const encrypted = JSON.stringify(await encryptSecret(env.AUTH_SECRET, `server:${input.id}`, key))
  const reserved = await env.INSTALLATION_DB.prepare("INSERT INTO servers (id,name,owner_id,origin,worker_name,secret,version,status,created_at,updated_at,public_id) SELECT ?,?,?,?, ?,?,?,'provisioning',?,?,? WHERE (SELECT count(*) FROM servers) < ? RETURNING *").bind(input.id, input.name, session.user.id, `https://pending.invalid/${input.id}`, workerName, encrypted, version, now, now, input.id, max).first<ServerRow>()
  if (!reserved) failure(409, 'This installation has reached its server limit')
  try {
    const result = await provisionServer(env, reserved, session.user, key)
    // Deployed, but not verified: the browser checks the server's health and reports back to `servers/:id/confirm`.
    await env.INSTALLATION_DB.prepare("UPDATE servers SET origin = ?,version = ?,status = 'provisioning',error = NULL,updated_at = ? WHERE id = ?").bind(new URL(result.url).origin, result.version, Date.now(), input.id).run()
    await audit(env, session.user.id, 'server.create', input.id)
    return json({ server: serverSummary(await serverRowProvisioning(env, input.id)), setupUrl: result.setupUrl }, 201)
  }
  catch (error) {
    await env.INSTALLATION_DB.prepare("UPDATE servers SET status = 'failed',error = ?,updated_at = ? WHERE id = ?").bind(error instanceof Error ? error.message.slice(0, 300) : 'Provisioning failed', Date.now(), input.id).run()
    throw error
  }
}

async function handle(request: Request, env: InstanceEnv): Promise<Response> {
  const url = new URL(request.url)
  // Published alpha.1 clients keep the legacy path; new clients use Instance.
  const path = url.pathname.replace(/^\/api\/instance(?=\/|$)/, '/api/installation')
  if (path === '/embed/open' && request.method === 'POST') return embedNavigation(request, env)
  const lookup = path.match(/^\/\.well-known\/llll\/servers\/([a-f0-9-]{36})$/)
  if (lookup) {
    const server = await env.INSTALLATION_DB.prepare("SELECT public_id FROM servers WHERE public_id = ? AND status = 'ready'").bind(lookup[1]).first()
    if (!server) failure(404, 'Server not found')
    return json({ id: lookup[1], origin: env.PUBLIC_ORIGIN })
  }
  if (path === '/.well-known/llll') return json({ product: 'llll', kind: 'installation', id: env.INSTALLATION_ID, name: env.INSTALLATION_NAME, apiVersion: INSTALLATION_API_VERSION, version, origin: env.PUBLIC_ORIGIN, registration: env.REGISTRATION_MODE === 'open', telegram: Boolean(env.TELEGRAM_BOT_TOKEN || env.TELEGRAM_TRUSTED_BOT_ID), telegramOidc: Boolean(env.TELEGRAM_CLIENT_ID && env.TELEGRAM_CLIENT_SECRET), identity: false, embedOrigins: embedOrigins(env.EMBED_ORIGINS), ready: Boolean(await ownerId(env)) })
  if (path === '/api/installation/recovery-key' && request.method === 'POST') {
    const session = await requireSession(request, env)
    if (Date.now() - new Date(session.session.createdAt).getTime() > 600000) failure(403, 'Sign in again before replacing your recovery key')
    const code = `llll-r-${randomToken()}`
    await env.INSTALLATION_DB.prepare('INSERT INTO account_recovery (user_id,code_hash,created_at) VALUES (?,?,?) ON CONFLICT(user_id) DO UPDATE SET code_hash = excluded.code_hash,created_at = excluded.created_at').bind(session.user.id, await digest(code), Date.now()).run()
    await audit(env, session.user.id, 'account.recovery-key.replace', session.user.id)
    return json({ code })
  }
  if (path === '/api/installation/recover' && request.method === 'POST') {
    const input = z.object({ email: z.string().email().max(200), code: z.string().min(32).max(100), password: z.string().min(10).max(128) }).parse(await body(request))
    const ip = await digest(request.headers.get('cf-connecting-ip') || 'local')
    const windowStart = Math.floor(Date.now() / 60000) * 60000
    await env.INSTALLATION_DB.prepare('DELETE FROM recovery_attempts WHERE window_start < ?').bind(windowStart - 60000).run()
    const attempts = await env.INSTALLATION_DB.prepare('INSERT INTO recovery_attempts (id,window_start,count) VALUES (?,?,1) ON CONFLICT(id) DO UPDATE SET count = CASE WHEN window_start = excluded.window_start THEN count + 1 ELSE 1 END,window_start = excluded.window_start RETURNING count').bind(ip, windowStart).first<{ count: number }>()
    if ((attempts?.count || 0) > 10) failure(429, 'Wait a minute before trying recovery again')
    const codeHash = await digest(input.code)
    const email = input.email.toLowerCase().trim()
    const key = await env.INSTALLATION_DB.prepare('SELECT user_id FROM account_recovery WHERE code_hash = ? AND user_id = (SELECT id FROM auth_users WHERE email = ?)').bind(codeHash, email).first<{ user_id: string }>()
    if (!key) failure(401, 'Recovery key could not be verified')
    const password = await hashPassword(input.password)
    const now = Date.now()
    const results = await env.INSTALLATION_DB.batch([
      env.INSTALLATION_DB.prepare("INSERT INTO auth_accounts (id,user_id,account_id,provider_id,password,created_at,updated_at) SELECT ?,user_id,user_id,'credential',?,?,? FROM account_recovery WHERE code_hash = ? AND user_id = ? ON CONFLICT(provider_id,account_id) DO UPDATE SET password = excluded.password,updated_at = excluded.updated_at").bind(crypto.randomUUID(), password, now, now, codeHash, key.user_id),
      env.INSTALLATION_DB.prepare('DELETE FROM auth_sessions WHERE user_id IN (SELECT user_id FROM account_recovery WHERE code_hash = ? AND user_id = ?)').bind(codeHash, key.user_id),
      env.INSTALLATION_DB.prepare('DELETE FROM account_recovery WHERE code_hash = ? AND user_id = ? RETURNING user_id').bind(codeHash, key.user_id),
    ])
    if (!results[2]?.results.length) failure(401, 'Recovery key could not be verified')
    await audit(env, key.user_id, 'account.recover', key.user_id)
    return json({ ok: true })
  }
  if (path === '/api/installation/setup' && request.method === 'POST') return setup(request, env)
  if (path === '/api/installation/consent') {
    await requireSession(request, env)
    const query = url.searchParams.get('query') || ''
    if (env.IDENTITY_PROVIDER !== 'true' || !await verifyOAuthQueryParams(query, env.AUTH_SECRET)) failure(400, 'Authorization request expired or could not be verified')
    const signed = new URLSearchParams(query)
    const client = await installationAuth(env).api.getOAuthClientPublic({ headers: request.headers, query: { client_id: signed.get('client_id') || '' } })
    return json({ client, scope: signed.get('scope'), claims: signed.get('claims') })
  }
  if (path.startsWith('/api/auth/')) {
    if (!await ownerId(env)) failure(409, 'The installation owner must complete setup first')
    let inviteToken = ''
    if (request.method === 'POST' && ['/api/auth/sign-up/email', '/api/auth/telegram/miniapp'].includes(path)) {
      const input = await body(request.clone()) as { inviteToken?: unknown; initData?: unknown }
      if (typeof input.inviteToken === 'string' && /^[a-f0-9]{64}$/.test(input.inviteToken)) inviteToken = input.inviteToken
      if (path.endsWith('/miniapp') && typeof input.initData === 'string') inviteToken = /^invite_([a-f0-9]{64})$/.exec(new URLSearchParams(input.initData).get('start_param') || '')?.[1] || ''
      if (inviteToken && !await validInvite(env, inviteToken)) failure(404, 'Invitation expired or is no longer available')
    }
    const auth = installationAuth(inviteToken ? { ...env, REGISTRATION_MODE: 'open' } : env)
    const response = await auth.handler(request)
    if (inviteToken && response.ok) {
      const token = response.headers.get('set-auth-token')
      const user = token ? await auth.api.getSession({ headers: new Headers({ Authorization: `Bearer ${token}` }) }) : null
      if (user) await admitInvite(env, inviteToken, user.user.id)
    }
    if (path === '/api/auth/oauth2/authorize' && request.method === 'GET' && response.ok && (request.headers.get('sec-fetch-mode') === 'navigate' || request.headers.get('accept')?.includes('text/html')) && response.headers.get('content-type')?.includes('application/json')) {
      const result = await response.clone().json() as { redirect?: boolean; url?: string }
      if (result.redirect && result.url) return Response.redirect(new URL(result.url, env.PUBLIC_ORIGIN).toString(), 302)
    }
    return response
  }
  const socketSession = path.match(/^\/api\/installation\/socket-session\/([a-z0-9-]+)$/)
  if (socketSession && request.method === 'POST') {
    const server = await serverRow(env, socketSession[1]!)
    let identity
    try { identity = await verifyInstallationIdentity(request.headers.get('x-llll-identity') || '', await secretFor(env, server), env.PUBLIC_ORIGIN, server.id) }
    catch { failure(401, 'Socket session could not be verified') }
    const active = await env.INSTALLATION_DB.prepare('SELECT id FROM auth_sessions WHERE id = ? AND user_id = ? AND expires_at > ?').bind(identity.sessionId, identity.sub, Date.now()).first()
    if (!active || !await membership(env, server.id, identity.sub)) failure(401, 'Socket session expired')
    return json({ ok: true })
  }
  if (path === '/api/installation/session') {
    const session = await requireSession(request, env)
    return json({ user: session.user, owner: session.user.id === await ownerId(env) })
  }
  if (path === '/api/installation/backup' && request.method === 'POST') {
    const session = await requireOwner(request, env)
    if (!env.BACKUPS) failure(409, 'Bind a separate BACKUPS bucket before saving installation backups')
    const createdAt = new Date().toISOString()
    const key = `installations/${env.INSTALLATION_ID}/${createdAt.replaceAll(':', '-')}.tar`
    const result = await uploadBackupToR2(env.BACKUPS, key, createStorageBackup(env.INSTALLATION_DB, undefined, createdAt, version))
    await audit(env, session.user.id, 'installation.backup', key)
    return json({ key, ...result, createdAt })
  }
  if (path === '/api/installation/settings') {
    await requireOwner(request, env)
    if (request.method === 'PUT') {
      const input = z.object({ telegramBotToken: z.string().max(300).optional(), telegramTrustedBotId: z.string().regex(/^[1-9]\d{0,15}$/).optional(), telegramClientId: z.string().max(200).optional(), telegramClientSecret: z.string().max(300).optional(), cloudflareAccountId: z.string().regex(/^[a-f0-9]{32}$/).optional(), cloudflareApiToken: z.string().min(32).max(300).optional() }).parse(await body(request))
      if (input.telegramBotToken) {
        const check = await fetch(`https://api.telegram.org/bot${input.telegramBotToken}/getMe`)
        const data = await check.json() as { ok?: boolean }
        if (!check.ok || !data.ok) failure(400, 'Telegram rejected this bot token')
      }
      const keys = { telegramBotToken: 'TELEGRAM_BOT_TOKEN', telegramTrustedBotId: 'TELEGRAM_TRUSTED_BOT_ID', telegramClientId: 'TELEGRAM_CLIENT_ID', telegramClientSecret: 'TELEGRAM_CLIENT_SECRET', cloudflareAccountId: 'CLOUDFLARE_ACCOUNT_ID', cloudflareApiToken: 'CLOUDFLARE_API_TOKEN' }
      for (const [field, key] of Object.entries(keys)) {
        const value = input[field as keyof typeof input]
        if (!value) continue
        const encrypted = JSON.stringify(await encryptSecret(env.AUTH_SECRET, `settings:${key}`, value))
        await env.INSTALLATION_DB.prepare('INSERT INTO integration_settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(key, encrypted).run()
      }
      return json({ ok: true })
    }
    return json({ telegram: Boolean(env.TELEGRAM_BOT_TOKEN || env.TELEGRAM_TRUSTED_BOT_ID), telegramOidc: Boolean(env.TELEGRAM_CLIENT_ID && env.TELEGRAM_CLIENT_SECRET), cloudflare: Boolean(env.CLOUDFLARE_ACCOUNT_ID && (env.CLOUDFLARE_API_TOKEN || await env.INSTALLATION_DB.prepare("SELECT key FROM integration_settings WHERE key='CLOUDFLARE_OAUTH_GRANT'").first())) })
  }
  if (path === '/api/installation/servers/register' && request.method === 'POST') return registerServer(request, env)
  if (request.method === 'POST' && /^\/api\/installation\/servers(?:$|\/[^/]+\/(?:retry|update)$)/.test(path)) env = await cloudflareCredentials(env)
  if (path === '/api/installation/servers') {
    if (request.method === 'POST') return createServer(request, env)
    const session = await requireSession(request, env)
    // A provisioning server whose browser never confirmed (tab closed, worker unreachable) would hang forever; expire it after ten minutes.
    await env.INSTALLATION_DB.prepare("UPDATE servers SET status = 'failed',error = 'Provisioning did not finish',updated_at = ? WHERE status = 'provisioning' AND updated_at < ?").bind(Date.now(), Date.now() - 600000).run()
    const rows = await env.INSTALLATION_DB.prepare('SELECT s.* FROM servers s WHERE s.owner_id = ? OR EXISTS (SELECT 1 FROM memberships m WHERE m.server_id = s.id AND m.user_id = ?) ORDER BY s.created_at,s.id').bind(session.user.id, session.user.id).all<ServerRow>()
    return json({ servers: await Promise.all(rows.results.map(async server => ({ ...serverSummary(server), assetToken: await assetToken(env, server.id, session.session.id) }))) })
  }
  const inviteRoute = path.match(/^\/api\/installation\/servers\/([a-z0-9-]+)\/invites$/)
  if (inviteRoute && request.method === 'POST') {
    const session = await requireSession(request, env)
    const server = await serverRow(env, inviteRoute[1]!)
    if (server.owner_id !== session.user.id) failure(403, 'Server owner access is required')
    const token = randomToken()
    await env.INSTALLATION_DB.prepare('INSERT INTO invites (token_hash,server_id,created_by,expires_at,max_uses) VALUES (?,?,?,?,?)').bind(await digest(token), server.id, session.user.id, Date.now() + 86400000, 100).run()
    return json({ invite: { token, url: `${env.PUBLIC_ORIGIN}/connections?invite=${token}` } })
  }
  if (path === '/api/installation/join' && request.method === 'POST') {
    const session = await requireSession(request, env)
    const input = z.object({ token: z.string().regex(/^[a-f0-9]{64}$/) }).parse(await body(request))
    return json({ serverId: await admitInvite(env, input.token, session.user.id) })
  }
  const retryRoute = path.match(/^\/api\/installation\/servers\/([a-z0-9-]+)\/retry$/)
  if (retryRoute && request.method === 'POST') {
    const session = await requireOwner(request, env)
    const reserved = await env.INSTALLATION_DB.prepare("UPDATE servers SET status = 'provisioning',error = NULL WHERE id = ? AND status = 'failed' RETURNING *").bind(retryRoute[1]).first<ServerRow>()
    if (!reserved) failure(409, 'Only a failed server can be retried')
    try {
      const result = await provisionServer(env, reserved, session.user, await secretFor(env, reserved))
      await env.INSTALLATION_DB.prepare("UPDATE servers SET origin = ?,version = ?,status = 'provisioning',error = NULL,updated_at = ? WHERE id = ?").bind(new URL(result.url).origin, result.version, Date.now(), reserved.id).run()
      await audit(env, session.user.id, 'server.retry', reserved.id)
      return json({ server: serverSummary(await serverRowProvisioning(env, reserved.id)), setupUrl: result.setupUrl })
    }
    catch (error) {
      await env.INSTALLATION_DB.prepare("UPDATE servers SET status = 'failed',error = ?,updated_at = ? WHERE id = ?").bind(error instanceof Error ? error.message.slice(0, 300) : 'Provisioning failed', Date.now(), reserved.id).run()
      throw error
    }
  }
  const confirmRoute = path.match(/^\/api\/installation\/servers\/([a-z0-9-]+)\/confirm$/)
  if (confirmRoute && request.method === 'POST') {
    await requireOwner(request, env)
    const server = await env.INSTALLATION_DB.prepare("SELECT * FROM servers WHERE id = ? AND status = 'provisioning'").bind(confirmRoute[1]).first<ServerRow>()
    if (!server) failure(409, 'Only a provisioning server can be confirmed')
    const input = z.object({ ok: z.boolean(), error: z.string().max(300).optional() }).parse(await body(request))
    if (input.ok) {
      await env.INSTALLATION_DB.prepare("UPDATE servers SET status = 'ready',updated_at = ? WHERE id = ?").bind(Date.now(), server.id).run()
      await env.INSTALLATION_DB.prepare("INSERT INTO memberships (server_id,user_id,role,created_at) VALUES (?,?,'owner',?) ON CONFLICT DO NOTHING").bind(server.id, server.owner_id, Date.now()).run()
    }
    else {
      await env.INSTALLATION_DB.prepare("UPDATE servers SET status = 'failed',error = ?,updated_at = ? WHERE id = ?").bind((input.error || 'Workspace health verification did not complete').slice(0, 300), Date.now(), server.id).run()
    }
    return json({ server: serverSummary(await serverRowProvisioning(env, server.id)) })
  }
  const updateRoute = path.match(/^\/api\/installation\/servers\/([a-z0-9-]+)\/update$/)
  if (updateRoute && request.method === 'POST') {
    const session = await requireOwner(request, env)
    const server = await serverRow(env, updateRoute[1]!)
    const input = z.object({ version: z.string().regex(/^v?\d+\.\d+\.\d+(?:-(?:alpha|beta|rc)\.\d+)?$/), skipBackup: z.boolean().default(false) }).parse(await body(request))
    if (!env.CLOUDFLARE_API_TOKEN || !env.CLOUDFLARE_ACCOUNT_ID) failure(409, 'Connect Cloudflare provisioning, or update this VPS deployment through its operator')
    if (!input.skipBackup) {
      const backupRequest = new Request(request.url, { method: 'POST', headers: request.headers, body: '{}' })
      const backup = await proxyServer(backupRequest, env, server.id, '/api/workspaces/main/backup-to-bucket')
      if (!backup.ok) failure(409, 'A server backup must succeed before updating. Configure its separate backup destination first.')
      if (env.BACKUPS) {
        const createdAt = new Date().toISOString()
        await uploadBackupToR2(env.BACKUPS, `installations/${env.INSTALLATION_ID}/${createdAt.replaceAll(':', '-')}.tar`, createStorageBackup(env.INSTALLATION_DB, undefined, createdAt, version))
      }
    }
    const result = await updateServer(env, server, input.version)
    await env.INSTALLATION_DB.prepare('UPDATE servers SET version = ?,updated_at = ? WHERE id = ?').bind(result.version, Date.now(), server.id).run()
    await audit(env, session.user.id, 'server.update', server.id)
    return json(result)
  }
  const serverRoute = path.match(/^\/s\/([a-z0-9-]+)(\/.*)$/)
  if (serverRoute) return proxyServer(request, env, serverRoute[1]!, serverRoute[2]!)
  if (path.startsWith('/api/')) return json({ error: { message: 'API route not found' } }, 404)
  if (env.ASSETS) return env.ASSETS.fetch(request)
  return new Response('Build the L4 client before starting this installation', { status: 503 })
}

export default {
  async fetch(request: Request, env: InstanceEnv): Promise<Response> {
    const settings = await env.INSTALLATION_DB.prepare('SELECT key,value FROM integration_settings').all<{ key: string; value: string }>()
    const configured = { ...env }
    for (const row of settings.results) {
      if (!['TELEGRAM_TRUSTED_BOT_ID', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CLIENT_ID', 'TELEGRAM_CLIENT_SECRET', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN'].includes(row.key)) continue
      if (env[row.key as keyof InstanceEnv]) continue
      Object.assign(configured, { [row.key]: await decryptSecret(env.AUTH_SECRET, `settings:${row.key}`, JSON.parse(row.value)) })
    }
    env = configured
    const origin = request.headers.get('origin')
    const allowed = !origin || clientOrigins(env).includes(origin)
    if (origin && !allowed) return json({ error: { message: 'This installation does not allow this client origin. Open its own client.' } }, 403)
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: origin ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Credentials': 'true', 'Access-Control-Allow-Methods': 'GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Llll-Client', 'Access-Control-Max-Age': '600', Vary: 'Origin' } : {} })
    let response: Response
    try { response = await handle(request, env) }
    catch (error) {
      const status = error instanceof z.ZodError ? 400 : typeof error === 'object' && error && 'status' in error ? Number(error.status) : 500
      if (status >= 500) console.error(JSON.stringify({ event: 'installation.request.failed', path: new URL(request.url).pathname, message: error instanceof Error ? error.message : 'Unknown error' }))
      response = json({ error: { message: status >= 500 ? 'Instance request failed' : error instanceof Error ? error.message : 'Request failed' } }, status)
    }
    if (response.status === 101) return response
    const result = new Response(response.body, response)
    result.headers.set('X-Content-Type-Options', 'nosniff')
    result.headers.set('Referrer-Policy', 'strict-origin')
    result.headers.set('Content-Security-Policy', "frame-ancestors 'self' " + embedOrigins(env.EMBED_ORIGINS).join(' '))
    result.headers.delete('X-Frame-Options')
    if (origin) {
      result.headers.set('Access-Control-Allow-Origin', origin)
      result.headers.set('Access-Control-Allow-Credentials', 'true')
      result.headers.set('Access-Control-Expose-Headers', 'set-auth-token')
      result.headers.append('Vary', 'Origin')
    }
    return result
  },
  async scheduled(_event: ScheduledController, env: InstanceEnv) {
    if (!env.BACKUPS) return
    const createdAt = new Date().toISOString()
    const key = `installations/${env.INSTALLATION_ID}/${createdAt.replaceAll(':', '-')}.tar`
    await uploadBackupToR2(env.BACKUPS, key, createStorageBackup(env.INSTALLATION_DB, undefined, createdAt, version))
  },
} satisfies ExportedHandler<InstanceEnv>
