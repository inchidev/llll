import { beforeEach, afterEach, it, expect, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import portal from '../../apps/site/src/index'
import type { PortalEnv } from '../../apps/site/src/env'
import { portalSession } from '../../apps/site/src/session'

let sqlite: DatabaseSync
let env: PortalEnv
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
const origin = 'https://portal.example.com'
const req = (path: string, cookie = '', body?: object) => new Request(origin + path, { method: body ? 'POST' : 'GET', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
beforeEach(() => {
  sqlite = new DatabaseSync(':memory:'); sqlite.exec(readFileSync('apps/site/migrations/0000_portal_baseline.sql', 'utf8'))
  env = { PORTAL_DB: d1(sqlite), ASSETS: { fetch: async () => new Response('static') } as Fetcher, AUTH_SECRET: 'test-secret-'.repeat(5), PUBLIC_ORIGIN: origin, CLOUDFLARE_OAUTH_CLIENT_ID: 'public-client' }
})
afterEach(() => { vi.unstubAllGlobals(); sqlite.close() })

it('binds OAuth to the browser, consumes callback state once, and stores credentials encrypted', async () => {
  const start = await portal.fetch(req('/api/deploy/oauth'), env)
  const cookie = start.headers.get('set-cookie')!.split(';')[0]!
  const auth = new URL(start.headers.get('location')!)
  expect(auth.searchParams.get('code_challenge_method')).toBe('S256')
  // These are the Workers scopes offered by Cloudflare's current client form.
  const scopes = auth.searchParams.get('scope')!.split(' ')
  expect(scopes).toEqual(expect.arrayContaining(['workers-scripts.content_read', 'workers-scripts.edit', 'offline_access']))
  expect(scopes).not.toContain('workers-scripts.read')
  expect(scopes).not.toContain('workers-scripts.write')
  expect((await portal.fetch(req('/api/deploy/callback?code=one&state=wrong', cookie), env)).status).toBe(400)
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('/oauth2/token')) return Response.json({ access_token: 'secret-access', refresh_token: 'secret-refresh', expires_in: 3600 })
    return Response.json({ success: true, result: [{ id: 'a'.repeat(32), name: 'My account' }] })
  }))
  const callback = '/api/deploy/callback?code=one&state=' + auth.searchParams.get('state')
  expect((await portal.fetch(req(callback, cookie), env)).status).toBe(303)
  expect((await portal.fetch(req(callback, cookie), env)).status).toBe(400)
  const response = await portal.fetch(req('/api/deploy/session', cookie), env)
  const text = await response.text()
  expect(text).toContain('My account'); expect(text).not.toContain('secret-access'); expect(text).not.toContain('secret-refresh')
  expect(JSON.stringify(sqlite.prepare('SELECT * FROM deployment_sessions').all())).not.toContain('secret-access')
  expect((await portalSession(req('/', cookie), env)).data.grant?.refreshToken).toBe('secret-refresh')
  const foreign = new Request(origin + '/api/deploy/start', { method: 'POST', headers: { Cookie: cookie, Origin: 'https://evil.example' }, body: '{}' })
  expect((await portal.fetch(foreign, env)).status).toBe(403)
})

it('requires an installation proof and prevents directory ownership replacement', async () => {
  const id = crypto.randomUUID()
  vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json({ id, origin: new URL(url).origin })))
  expect((await portal.fetch(req('/api/servers/register', '', { id, origin: 'https://one.example.com' }), env)).status).toBe(200)
  expect((await portal.fetch(req('/api/servers/register', '', { id, origin: 'https://two.example.com' }), env)).status).toBe(409)
  const result = await portal.fetch(req('/api/servers/' + id), env)
  expect(await result.json()).toEqual({ origin: 'https://one.example.com' })
  expect((await portal.fetch(req('/api/servers/register', '', { id: crypto.randomUUID(), origin: 'https://127.0.0.1' }), env)).status).toBe(400)
})
