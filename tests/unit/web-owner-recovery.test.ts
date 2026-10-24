import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import web from '../../apps/site/src/index'
import { webSession, digest } from '../../apps/site/src/session'
import { readL4Server } from '../../packages/deployment-core/src/servers'
import { INIT_SQL } from '../../server/utils/db'
import { d1 } from '../helpers/sqlite-d1'
import type { WebEnv } from '../../apps/site/src/env'
vi.mock('../../packages/deployment-core/src/servers', () => ({ listL4Servers: vi.fn(), readL4Server: vi.fn() }))
const accountId = 'a'.repeat(32), serverOrigin = 'https://community.example.com', origin = 'https://llll.gg'
let sqlite: DatabaseSync, server: DatabaseSync, env: WebEnv, cookie: string
const body = { accountId, workerName: 'community', origin: serverOrigin }
const req = (value = body, headers = {}) => new Request(origin + '/api/deploy/setup/recover', { method: 'POST', headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(value) })
beforeEach(async () => {
  sqlite = new DatabaseSync(':memory:'); sqlite.exec(readFileSync('apps/site/migrations/0000_web_baseline.sql', 'utf8'))
  server = new DatabaseSync(':memory:'); server.exec(INIT_SQL)
  server.prepare("INSERT INTO server_setup VALUES(1,'owner@example.com',?,'Community','now','now')").run(await digest('old-claim'))
  env = { DB: d1(sqlite), AUTH_SECRET: 'fixture-secret-'.repeat(4), PUBLIC_ORIGIN: origin, ASSETS: { fetch: async () => new Response('missing', { status: 404 }) } } as WebEnv
  const session = await webSession(new Request(origin), env, true)
  session.data.grant = { accessToken: 'fixture-grant', refreshToken: 'fixture-refresh', clientId: 'client', expiresAt: Date.now() + 3600000 }
  await session.save(); cookie = session.cookie.split(';')[0]!
  vi.mocked(readL4Server).mockResolvedValue({ origin: serverOrigin, configuration: { authMode: 'builtin' }, resources: { databaseId: 'server-db' }, version: '0.2.10' } as never)
  vi.stubGlobal('fetch', vi.fn(async (input: string, options?: RequestInit) => {
    const url = new URL(input)
    if (url.pathname === '/client/v4/accounts') return Response.json({ success: true, result: [{ id: accountId }] })
    if (url.pathname.endsWith('/d1/database/server-db/query')) {
      const { sql, params } = JSON.parse(String(options?.body)); const query = server.prepare(sql)
      return Response.json({ success: true, result: [{ success: true, results: query.all(...params) }] })
    }
    throw new Error('Unexpected fixture request')
  }))
})
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); sqlite.close(); server.close() })
it('recovers a fresh private claim after the original setup tab and installer state were lost', async () => {
  const response = await web.fetch(req(), env)
  expect(response.status).toBe(200)
  const { claim } = await response.json()
  const token = new URLSearchParams(new URL(claim).hash.slice(1)).get('claim')!
  expect(token.length).toBeGreaterThanOrEqual(32)
  expect(server.prepare('SELECT token_hash FROM server_setup').get()?.token_hash).toBe(await digest(token))
  const state = await webSession(new Request(origin, { headers: { Cookie: cookie } }), env)
  expect(state.data.deployments?.[0]).toMatchObject({ origin: serverOrigin, setupToken: token })
  expect(JSON.stringify(sqlite.prepare('SELECT payload FROM deployment_sessions').all())).not.toContain(token)
})
it('refuses to recover an already owned Server', async () => {
  server.exec("INSERT INTO server_identity(singleton,id) VALUES(1,'11111111-1111-4111-8111-111111111111'); INSERT INTO roles(id,key,name,permissions_bitmask) VALUES('owner-role','owner','Owner',0); INSERT INTO users(id,kind,display_name,status,role_id,joined_at) VALUES('owner','human','Owner','active','owner-role','now'); INSERT INTO server(id,name,owner_id) VALUES('11111111-1111-4111-8111-111111111111','Community','owner')")
  expect((await web.fetch(req(), env)).status).toBe(409)
  expect(server.prepare('SELECT token_hash FROM server_setup').get()?.token_hash).toBe(await digest('old-claim'))
})
it('requires a matching authorized Cloudflare account and Worker origin', async () => {
  expect((await web.fetch(req({ ...body, accountId: 'b'.repeat(32) }), env)).status).toBe(403)
  expect((await web.fetch(req({ ...body, origin: 'https://other.example.com' }), env)).status).toBe(403)
  expect((await web.fetch(req(body, { Origin: 'https://other.example.com' }), env)).status).toBe(403)
})
it('requires a live browser grant', async () => {
  const state = await webSession(new Request(origin, { headers: { Cookie: cookie } }), env)
  state.data.grant!.expiresAt = 0; await state.save()
  expect((await web.fetch(req(), env)).status).toBe(401)
})
