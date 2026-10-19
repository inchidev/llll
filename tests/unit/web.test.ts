import { beforeEach, afterEach, it, expect, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import web from '../../apps/site/src/index'
import type { WebEnv } from '../../apps/site/src/env'
import { webSession } from '../../apps/site/src/session'

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
  sqlite = new DatabaseSync(':memory:'); sqlite.exec(readFileSync('apps/site/migrations/0000_web_baseline.sql', 'utf8'))
  env = { DB: d1(sqlite), ASSETS: { fetch: async () => new Response('static') } as Fetcher, AUTH_SECRET: 'test-secret-'.repeat(5), PUBLIC_ORIGIN: origin, CLOUDFLARE_OAUTH_CLIENT_ID: 'public-client' }
})
afterEach(() => { vi.unstubAllGlobals(); sqlite.close() })

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
    ['/servers', '/create'],
  ]) {
    const response = await web.fetch(req(path), env)
    expect(response.status).toBe(307)
    expect(response.headers.get('location')).toBe(origin + expected)
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
