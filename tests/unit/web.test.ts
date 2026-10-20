import { beforeEach, afterEach, it, expect, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import web from '../../apps/site/src/index'
import type { WebEnv } from '../../apps/site/src/env'
import { listL4Servers } from '../../packages/deployment-core/src/servers'
import { webSession } from '../../apps/site/src/session'

vi.mock('../../packages/deployment-core/src/servers', () => ({ listL4Servers: vi.fn() }))

let sqlite: DatabaseSync
let env: WebEnv
function d1(database: DatabaseSync): D1Database {
  return {
    prepare(sql: string) {
      let args: (string | number | null)[] = []
      const statement = {
        bind(...values: (string | number | null)[]) { args = values; return statement },
        async first() { return database.prepare(sql).get(...args) || null },
        async all() { return { results: database.prepare(sql).all(...args) } },
        async run() { return database.prepare(sql).run(...args) },
      }
      return statement
    },
  } as D1Database
}
const origin = 'https://web.example.com'
const req = (path: string, cookie = '', body?: object) => new Request(origin + path, { method: body ? 'POST' : 'GET', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
beforeEach(() => {
  vi.mocked(listL4Servers).mockReset()
  sqlite = new DatabaseSync(':memory:'); sqlite.exec(readFileSync('apps/site/migrations/0000_web_baseline.sql', 'utf8'))
  env = { DB: d1(sqlite), ASSETS: { fetch: async () => new Response('static') } as Fetcher, AUTH_SECRET: 'test-secret-'.repeat(5), PUBLIC_ORIGIN: origin, CLOUDFLARE_OAUTH_CLIENT_ID: 'public-client' }
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); sqlite.close() })

it('serves a release installer as text and rejects SPA fallback for scripts and JSON', async () => {
  env.ASSETS = { fetch: async (request: Request) => new URL(request.url).pathname === '/install.sh'
    ? new Response('#!/bin/bash\nmain "$@"\n', { headers: { 'Content-Type': 'application/octet-stream' } })
    : new Response('<html>landing fallback</html>', { headers: { 'Content-Type': 'text/html; charset=utf-8' } }) } as Fetcher
  const installer = await web.fetch(req('/install.sh'), env)
  expect(installer.status).toBe(200)
  expect(installer.headers.get('Content-Type')).toBe('text/plain; charset=utf-8')
  expect(await installer.text()).toBe('#!/bin/bash\nmain "$@"\n')
  for (const path of ['/install-typo', '/install/missing', '/missing.sh', '/missing.SH', '/missing.json']) {
    const missing = await web.fetch(req(path), env)
    expect(missing.status).toBe(404)
    expect(await missing.text()).not.toContain('<html>')
  }
})

it('surfaces Cloudflare refusal reason on the deploy page instead of a generic cancellation', async () => {
  const start = await web.fetch(req('/api/deploy/oauth'), env)
  const cookie = start.headers.get('set-cookie')!.split(';')[0]!
  const auth = new URL(start.headers.get('location')!)
  const refused = '/api/deploy/callback?error=invalid_scope&error_description='
    + encodeURIComponent("The OAuth 2.0 Client is not allowed to request scope 'offline_access'.")
    + '&state=' + auth.searchParams.get('state')
  const callback = await web.fetch(req(refused, cookie), env)
  expect(callback.status).toBe(303)
  expect(callback.headers.get('location')).toBe(origin + '/create?tab=cloudflare')
  const session = await web.fetch(req('/api/deploy/session', cookie), env)
  expect(await session.text()).toContain('offline_access')
})

it('refuses to start when the grant cannot touch Workers scripts', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (String(url).endsWith('/llll-cloudflare-manifest.json')) return Response.json({version:new URL(String(url)).pathname.split('/').at(-2)!.slice(1),capabilities:['llll-server-schema-v1']})
    if (String(url).endsWith('/oauth2/token')) return Response.json({ access_token: 'secret-access', refresh_token: 'secret-refresh', expires_in: 3600 })
    if (String(url).includes('/workers/scripts')) return Response.json({ success: false, errors: [{ message: 'No access to the specified resource' }] }, { status: 403 })
    return Response.json({ success: true, result: [{ id: 'a'.repeat(32), name: 'My account' }] })
  }))
  const start = await web.fetch(req('/api/deploy/oauth'), env)
  const cookie = start.headers.get('set-cookie')!.split(';')[0]!
  const auth = new URL(start.headers.get('location')!)
  await web.fetch(req('/api/deploy/callback?code=one&state=' + auth.searchParams.get('state'), cookie), env)
  const blocked = await web.fetch(req('/api/deploy/start', cookie, { ownerEmail: 'owner@example.com', accountId: 'a'.repeat(32), name: 'Community', version: 'v0.4.1' }), env)
  expect(blocked.status).toBe(403)
  expect(await blocked.text()).toContain('Workers access')
})

it('binds OAuth to the browser, consumes callback state once, and stores credentials encrypted', async () => {
  const start = await web.fetch(req('/api/deploy/oauth'), env)
  const cookie = start.headers.get('set-cookie')!.split(';')[0]!
  const auth = new URL(start.headers.get('location')!)
  expect(auth.searchParams.get('code_challenge_method')).toBe('S256')
  const scopes = auth.searchParams.get('scope')!.split(' ')
  expect(scopes).toEqual(expect.arrayContaining(['workers-ci.read', 'workers-ci.write']))
  expect(scopes).toEqual(expect.arrayContaining(['workers-scripts.content_read', 'workers-scripts.admin', 'offline_access', 'zone.read', 'dns.read', 'dns.write', 'email-routing-rule.read', 'email-routing-rule.write', 'email-sending.read', 'email-sending.write', 'browser-rendering.read', 'containers.read', 'containers.write', 'realtime.read', 'realtime.write', 'queues.read', 'queues.write']))
  expect(scopes).not.toContain('workers-scripts.read')
  expect(scopes).not.toContain('workers-scripts.write')
  expect((await web.fetch(req('/api/deploy/callback?code=one&state=wrong', cookie), env)).status).toBe(400)
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('/oauth2/token')) return Response.json({ access_token: 'secret-access', refresh_token: 'secret-refresh', expires_in: 3600 })
    return Response.json({ success: true, result: [{ id: 'a'.repeat(32), name: 'My account' }] })
  }))
  const callback = '/api/deploy/callback?code=one&state=' + auth.searchParams.get('state')
  const authorized = await web.fetch(req(callback, cookie), env)
  expect(authorized.status).toBe(303)
  expect(authorized.headers.get('location')).toBe(origin + '/create?tab=cloudflare')
  expect((await web.fetch(req(callback, cookie), env)).status).toBe(400)
  const response = await web.fetch(req('/api/deploy/session', cookie), env)
  const text = await response.text()
  expect(text).toContain('My account'); expect(text).not.toContain('secret-access'); expect(text).not.toContain('secret-refresh')
  expect(JSON.stringify(sqlite.prepare('SELECT * FROM deployment_sessions').all())).not.toContain('secret-access')
  expect((await webSession(req('/', cookie), env)).data.grant?.refreshToken).toBe('secret-refresh')
  const foreign = new Request(origin + '/api/deploy/start', { method: 'POST', headers: { Cookie: cookie, Origin: 'https://evil.example' }, body: '{}' })
  expect((await web.fetch(foreign, env)).status).toBe(403)
})

it('redirects old entry links on the current origin and preserves connection parameters', async () => {
  for (const [path, expected] of [
    ['/open/?server=https%3A%2F%2Fchat.example.com', '/create?server=https%3A%2F%2Fchat.example.com'],
    ['/deploy/', '/create?tab=cloudflare'],
    ['/deploy?method=vps', '/create?tab=vps'],
    ['/servers?server=https%3A%2F%2Fchat.example.com', '/create?server=https%3A%2F%2Fchat.example.com'],
  ]) {
    const response = await web.fetch(req(path), env)
    expect(response.status).toBe(307)
    expect(response.headers.get('location')).toBe(origin + expected)
  }
})

it('serves My servers directly rather than redirecting it to the installer', async () => {
  for (const path of ['/servers', '/servers/']) {
    for (const method of ['GET', 'HEAD']) {
      const response = await web.fetch(new Request(origin + path, { method }), env)
      expect(response.status).toBe(200)
      expect(response.headers.get('location')).toBeNull()
      expect(await response.text()).toBe('static')
    }
  }
})

it('lists published releases for the deploy picker and pins the chosen version to the deployment', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (String(url).startsWith('https://api.github.com/')) return Response.json([
      { tag_name: 'v0.3.1', name: 'L4 0.3.1', draft: false, prerelease: false, assets: ['llll-deployment.json', 'llll-cloudflare-manifest.json', 'SHA256SUMS'].map(name => ({ name })), published_at: '2026-10-16T15:26:10Z', html_url: 'https://github.com/inchidev/llll/releases/tag/v0.3.1' },
      { tag_name: 'preview-20261016-b70b163', draft: false },
      { tag_name: 'v0.3.2', name: 'L4 0.3.2 RC', draft: false, prerelease: true, assets: ['llll-deployment.json', 'llll-cloudflare-manifest.json', 'SHA256SUMS'].map(name => ({ name })) },
      { tag_name: 'v0.3.0', name: 'L4 0.3.0', draft: true, assets: ['llll-deployment.json', 'llll-cloudflare-manifest.json', 'SHA256SUMS'].map(name => ({ name })) },
      { tag_name: 'v0.2.3', name: 'L4 0.2.3', draft: false, prerelease: false, assets: ['llll-deployment.json', 'llll-cloudflare-manifest.json', 'SHA256SUMS'].map(name => ({ name })), published_at: '2026-10-16T10:45:52Z', html_url: 'https://github.com/inchidev/llll/releases/tag/v0.2.3' },
    ])
    if (String(url).endsWith('/llll-cloudflare-manifest.json')) return Response.json({version:new URL(String(url)).pathname.split('/').at(-2)!.slice(1),capabilities:['llll-server-schema-v1']})
    if (String(url).endsWith('/oauth2/token')) return Response.json({ access_token: 'secret-access', refresh_token: 'secret-refresh', expires_in: 3600 })
    if (String(url).endsWith('/builds/tokens')) return Response.json({ success: true, result: [{ build_token_uuid: 'build-token' }] })
    return Response.json({ success: true, result: [{ id: 'a'.repeat(32), name: 'My account' }] })
  }))
  const listing = await web.fetch(req('/api/deploy/releases'), env)
  expect(await listing.json()).toEqual({ releases: [
    { version: 'v0.3.1', name: 'L4 0.3.1', published_at: '2026-10-16T15:26:10Z', notes_url: 'https://github.com/inchidev/llll/releases/tag/v0.3.1' },
    { version: 'v0.2.3', name: 'L4 0.2.3', published_at: '2026-10-16T10:45:52Z', notes_url: 'https://github.com/inchidev/llll/releases/tag/v0.2.3' },
  ] })
  const start = await web.fetch(req('/api/deploy/oauth'), env)
  const cookie = start.headers.get('set-cookie')!.split(';')[0]!
  const auth = new URL(start.headers.get('location')!)
  await web.fetch(req('/api/deploy/callback?code=one&state=' + auth.searchParams.get('state'), cookie), env)
  const bad = await web.fetch(req('/api/deploy/start', cookie, { ownerEmail: 'owner@example.com', accountId: 'a'.repeat(32), name: 'Community', version: 'latest' }), env)
  expect(bad.status).toBe(400)
  const good = await web.fetch(req('/api/deploy/start', cookie, { ownerEmail: 'owner@example.com', accountId: 'a'.repeat(32), name: 'Community', version: 'v0.3.1' }), env)
  expect(good.status).toBe(200)
  const session = await web.fetch(req('/api/deploy/session', cookie), env)
  expect((await session.json()).version).toBe('v0.3.1')
  const state = await (await web.fetch(req('/api/deploy/session', cookie), env)).json() as { grantExpiresIn?: number }
  expect(state.grantExpiresIn).toBeGreaterThan(0)
})

it('rejects missing Builds permissions before starting and allows retry after reconnecting', async () => {
  let buildsAllowed = false
  const calls: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    calls.push(`${options?.method || 'GET'} ${url}`)
    if (url.endsWith('/oauth2/token')) return Response.json({ access_token: 'secret-access', refresh_token: 'secret-refresh', expires_in: 3600 })
    if (url.endsWith('/builds/tokens')) return buildsAllowed
      ? Response.json({ success: true, result: [{ build_token_uuid: 'build-token' }] })
      : Response.json({ success: false, errors: [{ code: 10000, message: 'Authentication error' }] }, { status: 403 })
    return Response.json({ success: true, result: [{ id: 'a'.repeat(32), name: 'My account' }] })
  }))
  const start = await web.fetch(req('/api/deploy/oauth'), env)
  const cookie = start.headers.get('set-cookie')!.split(';')[0]!
  const auth = new URL(start.headers.get('location')!)
  await web.fetch(req('/api/deploy/callback?code=one&state=' + auth.searchParams.get('state'), cookie), env)
  const body = { ownerEmail: 'owner@example.com', accountId: 'a'.repeat(32), name: 'Community', version: 'v0.2.0-alpha.1' }
  const denied = await web.fetch(req('/api/deploy/start', cookie, body), env)
  expect(denied.status).toBe(403)
  expect(await denied.text()).toContain('Reconnect Cloudflare')
  expect((await webSession(req('/', cookie), env)).data.worker).toBeUndefined()
  expect(calls.some(call => call.includes('/workers/workers') && call.startsWith('POST'))).toBe(false)
  buildsAllowed = true
  expect((await web.fetch(req('/api/deploy/start', cookie, body), env)).status).toBe(200)
  expect((await webSession(req('/', cookie), env)).data.buildTokenId).toBe('build-token')
})

it('requires an server proof and prevents directory ownership replacement', async () => {
  const id = crypto.randomUUID()
  vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json({ kind: 'server', id, origin: new URL(url).origin })))
  expect((await web.fetch(req('/api/servers/register', '', { id, origin: 'https://one.example.com' }), env)).status).toBe(200)
  expect((await web.fetch(req('/api/servers/register', '', { id, origin: 'https://two.example.com' }), env)).status).toBe(409)
  const result = await web.fetch(req('/api/servers/' + id), env)
  expect(await result.json()).toEqual({ origin: 'https://one.example.com' })
  expect((await web.fetch(req('/api/servers/register', '', { id: crypto.randomUUID(), origin: 'https://127.0.0.1' }), env)).status).toBe(400)
})

async function connectedSession(completed = false) {
  const session = await webSession(req('/'), env, true)
  Object.assign(session.data, {
    grant: { accessToken: 'private-access', refreshToken: 'private-refresh', clientId: 'client', expiresAt: Date.now() + 3600000 },
    ...(completed ? { completed: true, step: 3, worker: 'first', accountId: 'a'.repeat(32), name: 'First', version: 'v0.2.0-alpha.3', origin: 'https://first.workers.dev', setupToken: 'first-claim-'.padEnd(64, 'x') } : {}),
  })
  await session.save()
  return session.cookie.split(';')[0]!
}

it('keeps account access after completion and allows another deployment without losing the first claim', async () => {
  const cookie = await connectedSession(true)
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('/builds/tokens')) return Response.json({ success: true, result: [{ build_token_uuid: 'build-token' }] })
    return Response.json({ success: true, result: [{ id: 'a'.repeat(32), name: 'Account' }] })
  }))
  const before = await (await web.fetch(req('/api/deploy/session', cookie), env)).json()
  expect(before.authorized).toBe(true)
  expect(before.accounts).toEqual([{ id: 'a'.repeat(32), name: 'Account' }])
  expect(before.sessionExpiresAt).toBeGreaterThan(Date.now())
  const started = await web.fetch(req('/api/deploy/start', cookie, { accountId: 'a'.repeat(32), ownerEmail: 'next@example.com', name: 'Second', version: 'v0.2.0-alpha.3' }), env)
  expect(started.status).toBe(200)
  const state = await webSession(req('/', cookie), env)
  expect(state.data.completed).toBeUndefined()
  expect(state.data.name).toBe('Second')
  expect(state.data.grant?.accessToken).toBe('private-access')
  expect(state.data.deployments).toEqual([expect.objectContaining({ origin: 'https://first.workers.dev', setupToken: 'first-claim-'.padEnd(64, 'x') })])
  expect((await web.fetch(req('/api/deploy/start', cookie, { accountId: 'a'.repeat(32), ownerEmail: 'next@example.com', name: 'Third', version: 'v0.2.0-alpha.3' }), env)).status).toBe(409)
  const payload = await (await web.fetch(req('/api/deploy/session', cookie), env)).text()
  expect(payload).not.toContain('private-access')
  expect(payload).not.toContain('private-refresh')
  expect(JSON.stringify(sqlite.prepare('SELECT * FROM deployment_sessions').all())).not.toContain('first-claim-')
})

it('scopes inventory to an authorized account and exposes only public Server metadata', async () => {
  const cookie = await connectedSession()
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ success: true, result: [{ id: 'a'.repeat(32), name: 'Account' }] })))
  vi.mocked(listL4Servers).mockResolvedValue([{
    accountId: 'a'.repeat(32), workerName: 'community', origin: 'https://community.workers.dev', version: '0.2.0-alpha.3',
    configuration: { accountId: 'a'.repeat(32), workerName: 'community', appName: 'Community', adminEmail: '', allowedEmails: [], authMode: 'builtin', registrationMode: 'invite_only', customDomainEnabled: false, zoneId: '', zoneName: '', appSubdomain: 'community', mailEnabled: false, mailSubdomain: '', mailLocalPart: '' },
    resources: { databaseId: 'private-db', bucketName: 'private-files', kvId: null, mailZoneId: null, mailDomain: null, accessApplicationId: null, accessHealthApplicationId: null, accessDeletionApplicationId: null },
  }])
  const denied = await web.fetch(req('/api/deploy/servers?accountId=' + 'b'.repeat(32), cookie), env)
  expect(denied.status).toBe(403)
  expect(listL4Servers).not.toHaveBeenCalled()
  const response = await web.fetch(req('/api/deploy/servers?accountId=' + 'a'.repeat(32), cookie), env)
  expect(response.status).toBe(200)
  expect(response.headers.get('cache-control')).toBe('no-store')
  expect(await response.json()).toEqual({ servers: [{ accountId: 'a'.repeat(32), origin: 'https://community.workers.dev', name: 'Community', version: '0.2.0-alpha.3' }] })
  expect(listL4Servers).toHaveBeenCalledWith('private-access', 'a'.repeat(32), { strict: true })
})

it('does not extend the installer deadline on reads or progress saves, and rejects expired grants', async () => {
  const cookie = await connectedSession()
  const session = await webSession(req('/', cookie), env)
  const deadline = session.expiresAt
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 5000)
  session.data.grant!.expiresAt = Date.now() - 1
  await session.save()
  expect((await webSession(req('/', cookie), env)).expiresAt).toBe(deadline)
  const response = await web.fetch(req('/api/deploy/session', cookie), env)
  expect((await response.json()).authorized).toBe(false)
  expect((await web.fetch(req('/api/deploy/servers?accountId=' + 'a'.repeat(32), cookie), env)).status).toBe(401)
  sqlite.prepare('UPDATE deployment_sessions SET expires_at=?').run(Date.now() - 1)
  expect((await web.fetch(req('/api/deploy/session', cookie), env)).status).toBe(401)
})

it('renews the browser deadline only on explicit OAuth reconnect and preserves completed setup handoffs', async () => {
  const cookie = await connectedSession(true)
  sqlite.prepare('UPDATE deployment_sessions SET expires_at=?').run(Date.now() + 1000)
  const old = await webSession(req('/', cookie), env)
  const response = await web.fetch(req('/api/deploy/oauth', cookie), env)
  expect(response.status).toBe(302)
  expect(response.headers.get('set-cookie')).toContain('Max-Age=3600')
  const renewed = await webSession(req('/', cookie), env)
  expect(renewed.expiresAt).toBeGreaterThan(old.expiresAt + 3500000)
  expect(renewed.data.origin).toBe('https://first.workers.dev')
})
