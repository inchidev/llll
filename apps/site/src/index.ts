import { z } from 'zod'
import { CLOUDFLARE_AUTH_URL, CLOUDFLARE_SCOPES, oauthGrant, pkceChallenge, randomCode } from '../../../shared/cloudflare-oauth'
import { uuidSchema } from '../../../shared/embed'
import { advanceDeployment, cloudflare, deploymentParameters, listReleases, VERSION_PATTERN } from './deploy'
import { portalSession, digest } from './session'
import type { PortalEnv } from './env'

function fail(status: number, message: string): never { throw Object.assign(new Error(message), { status }) }
function json(data: unknown, status = 200) { return Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } }) }
async function boundedText(response: Response | Request) {
  if (!response.body) return ''
  const reader = response.body.getReader(); let text = ''; let size = 0; const decoder = new TextDecoder()
  while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 8192) { await reader.cancel(); fail(413, 'Request too large') } text += decoder.decode(value, { stream: true }) }
  return text + decoder.decode()
}
async function input(request: Request): Promise<unknown> { try { return JSON.parse(await boundedText(request)) } catch { fail(400, 'Invalid request') } }
function publicOrigin(value: string, env: PortalEnv) {
  const url = new URL(value)
  const local = env.TEST_ALLOW_LOCAL_ORIGINS === 'true' && ['localhost', '127.0.0.1'].includes(url.hostname)
  if (url.origin !== value || (!local && (url.protocol !== 'https:' || !url.hostname.includes('.') || /^(?:\d|\[)/.test(url.hostname) || /\.(?:localhost|local|internal|test|invalid)$/.test(url.hostname)))) fail(400, 'Enter a public HTTPS installation origin')
  return url.origin
}
async function rateLimit(request: Request, env: PortalEnv) {
  const key = await digest((request.headers.get('cf-connecting-ip') || 'local') + ':' + Math.floor(Date.now() / 60000))
  const row = await env.PORTAL_DB.prepare('INSERT INTO rate_limits(key,count,expires_at) VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1 RETURNING count').bind(key, Date.now() + 120000).first<{ count: number }>()
  if ((row?.count || 0) > 60) fail(429, 'Too many requests. Try again shortly.')
}
async function handle(request: Request, env: PortalEnv): Promise<Response> {
  const url = new URL(request.url); const path = url.pathname
  if (path.startsWith('/api/') && !['GET', 'HEAD'].includes(request.method)) {
    if (request.headers.get('origin') !== env.PUBLIC_ORIGIN) fail(403, 'Origin mismatch')
    await rateLimit(request, env)
  }
  if (path === '/api/servers/register' && request.method === 'POST') {
    const value = z.object({ id: uuidSchema, origin: z.string().max(2048) }).parse(await input(request))
    const origin = publicOrigin(value.origin, env)
    const proof = await fetch(origin + '/.well-known/llll/servers/' + value.id, { redirect: 'manual', signal: AbortSignal.timeout(10000) })
    if (!proof.ok) fail(400, 'The installation could not verify this server')
    const data = JSON.parse(await boundedText(proof)) as { id?: string; origin?: string }
    if (data.id !== value.id || data.origin !== origin) fail(400, 'Server ownership proof did not match')
    const registered = await env.PORTAL_DB.prepare('INSERT INTO server_directory(id,origin,verified_at) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET verified_at=excluded.verified_at WHERE origin=excluded.origin RETURNING id').bind(value.id, origin, Date.now()).first()
    if (!registered) fail(409, 'This server ID is registered to another installation')
    return json({ ok: true })
  }
  const lookup = path.match(/^\/api\/servers\/([a-f0-9-]{36})$/)
  if (lookup && request.method === 'GET') {
    if (!uuidSchema.safeParse(lookup[1]).success) fail(404, 'Server not found')
    const row = await env.PORTAL_DB.prepare('SELECT origin FROM server_directory WHERE id=?').bind(lookup[1]).first<{ origin: string }>()
    if (!row) fail(404, 'Server is not in the directory. Connect its installation by address.')
    return json(row)
  }
  if (path === '/api/deploy/config') return json({ oauth: Boolean(env.CLOUDFLARE_OAUTH_CLIENT_ID) })
  if (path === '/api/deploy/releases' && request.method === 'GET') {
    const cacheKey = new Request(env.PUBLIC_ORIGIN + '/api/deploy/releases')
    try {
      const cached = await caches.default.match(cacheKey)
      if (cached) return new Response(cached.body, cached)
    } catch { /* Cache API unavailable in tests; fetch directly. */ }
    const releases = await listReleases(env.GITHUB_TOKEN)
    const response = new Response(JSON.stringify({ releases }), { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' } })
    try { await caches.default.put(cacheKey, response.clone()) } catch { /* See above. */ }
    return response
  }
  if (path === '/api/deploy/oauth' && request.method === 'GET') {
    if (!env.CLOUDFLARE_OAUTH_CLIENT_ID) fail(503, 'Cloudflare OAuth is not configured yet')
    await rateLimit(request, env)
    const session = await portalSession(request, env, true)
    if (session.data.worker && !session.data.completed && url.searchParams.get('resume') !== '1') fail(409, 'Resume your current deployment before starting another')
    if (session.data.completed) for (const key of Object.keys(session.data)) Reflect.deleteProperty(session.data, key)
    session.data.state = randomCode(); session.data.verifier = randomCode(); delete session.data.error
    await session.save()
    const target = new URL(CLOUDFLARE_AUTH_URL)
    target.search = new URLSearchParams({ response_type: 'code', client_id: env.CLOUDFLARE_OAUTH_CLIENT_ID, redirect_uri: env.PUBLIC_ORIGIN + '/api/deploy/callback', scope: CLOUDFLARE_SCOPES, state: session.data.state, code_challenge: await pkceChallenge(session.data.verifier), code_challenge_method: 'S256' }).toString()
    return new Response(null, { status: 302, headers: { Location: target.toString(), ...(session.cookie ? { 'Set-Cookie': session.cookie } : {}) } })
  }
  if (path === '/api/deploy/callback' && request.method === 'GET') {
    const session = await portalSession(request, env)
    if (!session.data.state || url.searchParams.get('state') !== session.data.state || !session.data.verifier) fail(400, 'Authorization could not be verified. Start again.')
    const verifier = session.data.verifier
    delete session.data.state; delete session.data.verifier; await session.save()
    if (url.searchParams.has('error') || !url.searchParams.get('code')) {
      // Surface Cloudflare's reason (it names the refused scope) instead of a generic cancellation.
      const detail = (url.searchParams.get('error_description') || '').slice(0, 300)
      session.data.error = detail ? `Cloudflare refused the authorization: ${detail}` : 'Cloudflare authorization was cancelled'
      await session.save(); return Response.redirect(env.PUBLIC_ORIGIN + '/deploy', 303)
    }
    session.data.grant = await oauthGrant(new URLSearchParams({ grant_type: 'authorization_code', code: url.searchParams.get('code')!, code_verifier: verifier, redirect_uri: env.PUBLIC_ORIGIN + '/api/deploy/callback' }), env.CLOUDFLARE_OAUTH_CLIENT_ID!)
    if (session.data.accountId) {
      const accounts = await cloudflare<{ id: string }[]>(session.data.grant.accessToken, '/accounts')
      if (!accounts.some(account => account.id === session.data.accountId)) { delete session.data.grant; await session.save(); fail(403, 'Reconnect the same Cloudflare account to resume this installation') }
    }
    await session.save()
    return Response.redirect(env.PUBLIC_ORIGIN + '/deploy', 303)
  }
  if (path === '/api/deploy/session') {
    const session = await portalSession(request, env); const data = session.data
    const accounts = data.grant && !data.worker ? await cloudflare<{ id: string; name: string }[]>(data.grant.accessToken, '/accounts') : []
    return json({ authorized: Boolean(data.grant), accounts: accounts.map(a => ({ id: a.id, name: a.name })), step: data.step, name: data.name, version: data.version, grantExpiresIn: data.grant ? Math.max(0, Math.round((data.grant.expiresAt - Date.now()) / 1000)) : undefined, error: data.error, completed: data.completed, claim: data.completed ? `${data.origin}/connections#claim=${data.setupToken}` : undefined, origin: data.completed ? data.origin : undefined })
  }
  if (path === '/api/deploy/start' && request.method === 'POST') {
    const session = await portalSession(request, env)
    if (!session.data.grant) fail(401, 'Connect Cloudflare first')
    if (session.data.worker) fail(409, 'Resume the existing deployment')
    const value = z.object({ accountId: z.string().regex(/^[a-f0-9]{32}$/), name: z.string().trim().min(1).max(80), version: z.string().regex(VERSION_PATTERN) }).parse(await input(request))
    const accounts = await cloudflare<{ id: string }[]>(session.data.grant.accessToken, '/accounts')
    if (!accounts.some(a => a.id === value.accountId)) fail(403, 'Choose an account authorized by Cloudflare')
    // Fail fast when the grant cannot touch Workers scripts (unchecked consent
    // scope or a Cloudflare user role without Workers rights). Otherwise this
    // surfaces two phases later as an assets-upload 403.
    try {
      const probe = await fetch(`https://api.cloudflare.com/client/v4/accounts/${value.accountId}/workers/scripts?per_page=1`, { headers: { Authorization: `Bearer ${session.data.grant.accessToken}` }, signal: AbortSignal.timeout(20000) })
      if (probe.status === 403) fail(403, 'Cloudflare denied Workers access for this grant. Reconnect Cloudflare and approve every requested permission, or ask an account admin for Workers rights.')
    } catch (error) { if (error instanceof Error && 'status' in error) throw error }
    Object.assign(session.data, deploymentParameters(value.accountId, value.name, value.version)); await session.save()
    return json({ ok: true })
  }
  if (path === '/api/deploy/advance' && request.method === 'POST') {
    const session = await portalSession(request, env)
    if (session.data.completed) return json({ completed: true })
    const leaseUntil = Date.now() + 600000
    const lease = await env.PORTAL_DB.prepare('UPDATE deployment_sessions SET lease_until=? WHERE id_hash=? AND lease_until<? RETURNING id_hash').bind(leaseUntil, session.id, Date.now()).first()
    if (!lease) fail(409, 'Deployment is already running; wait before retrying')
    try { delete session.data.error; await advanceDeployment(session.data, env, session.save) }
    catch (error) { session.data.error = error instanceof Error ? error.message : 'Deployment failed. Retry to resume.'; await session.save(); throw error }
    finally { await env.PORTAL_DB.prepare('UPDATE deployment_sessions SET lease_until=0 WHERE id_hash=? AND lease_until=?').bind(session.id, leaseUntil).run() }
    return json({ step: session.data.step, completed: session.data.completed })
  }
  if (path === '/.well-known/llll') return json({ product: 'llll', kind: 'client', origin: env.PUBLIC_ORIGIN, id: 'client', name: 'L4', apiVersion: 1 })
  if (path.startsWith('/api/')) fail(404, 'API route not found')
  // Static Assets' SPA fallback is index.html, which is the prerendered landing
  // page. UUID routes need Nuxt's client-only entry to preserve their URL.
  const serverPath = /^\/([a-f0-9-]{36})(?:\/|$)/i.exec(path)
  if (['GET', 'HEAD'].includes(request.method) && serverPath && uuidSchema.safeParse(serverPath[1]).success) {
    return env.ASSETS.fetch(new Request(new URL('/200.html', url), request))
  }
  return env.ASSETS.fetch(request)
}
export default {
  async fetch(request: Request, env: PortalEnv) {
    let response: Response
    try { response = await handle(request, env) }
    catch (error) {
      const status = error instanceof z.ZodError ? 400 : typeof error === 'object' && error && 'status' in error ? Number(error.status) : 500
      response = json({ error: { message: error instanceof z.ZodError ? 'Invalid request' : error instanceof Error ? error.message : 'Request failed' } }, status)
    }
    const output = new Response(response.body, response)
    output.headers.set('Referrer-Policy', 'no-referrer'); output.headers.set('X-Content-Type-Options', 'nosniff')
    output.headers.set('Content-Security-Policy', "frame-ancestors 'none'; base-uri 'self'; object-src 'none'")
    return output
  },
  async scheduled(_event: ScheduledController, env: PortalEnv) {
    await env.PORTAL_DB.batch([env.PORTAL_DB.prepare('DELETE FROM deployment_sessions WHERE expires_at<?').bind(Date.now()), env.PORTAL_DB.prepare('DELETE FROM rate_limits WHERE expires_at<?').bind(Date.now())])
  },
} satisfies ExportedHandler<PortalEnv>
