import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { d1 } from '../helpers/sqlite-d1'
import type { L4Env } from '../../workers/env'

const cf = vi.hoisted(() => ({ connectAppDomain: vi.fn(), setPrimaryAppDomain: vi.fn(), disconnectAppDomain: vi.fn(), findAppDomain: vi.fn(), findAppDomainZone: vi.fn(async () => ({ id: 'zone', name: 'example.com', status: 'active' })), connectEmailDomain: vi.fn(), disconnectEmailDomain: vi.fn() }))
vi.mock('../../packages/deployment-core/src/domains', () => cf)
vi.mock('../../packages/deployment-core/src/servers', () => ({ listAccountZones: async () => [{ id: 'zone', name: 'example.com', status: 'active' }] }))
vi.mock('../../server/utils/cloudflare-account-access', () => ({ cloudflareAccessStatus: async () => ({ connected: true }), cloudflareAccessToken: async () => ({ token: 'kept', accountId: 'a'.repeat(32) }) }))
vi.mock('../../server/utils/server-updates', () => ({ serverDeployment: async () => ({ accountId: 'a'.repeat(32), workerName: 'llll-server', site: '', origin: 'https://server.example' }), serverDomainLaunchUrl: vi.fn() }))

let db: DatabaseSync, env: L4Env
beforeEach(() => {
  db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE server_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE server(id TEXT,owner_id TEXT); INSERT INTO server VALUES('11111111-1111-4111-8111-111111111111','owner');
    CREATE TABLE server_domains(origin TEXT PRIMARY KEY,hostname TEXT NOT NULL,is_primary INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL);
    CREATE TABLE server_domain_requests(id TEXT PRIMARY KEY,action TEXT,hostname TEXT,token_hash TEXT,status TEXT,error TEXT,created_at TEXT,updated_at TEXT);
    CREATE TABLE email_domains(id TEXT PRIMARY KEY,zone_id TEXT,domain TEXT,app_hostname TEXT,created_at TEXT,updated_at TEXT);
    CREATE TABLE email_mailboxes(channel_id TEXT,domain_id TEXT)`)
  env = { DB: d1(db), ACCOUNT_ID: 'a'.repeat(32), PUBLIC_ORIGIN: 'https://server.example' } as unknown as L4Env
  Object.values(cf).forEach(fn => fn.mockClear())
})
afterEach(() => db.close())

it('adds and promotes an address with the kept access, without an installer link', async () => {
  const { connectManagedAppDomain } = await import('../../server/utils/server-infrastructure')
  const result = await connectManagedAppDomain(env, { hostname: 'chat.example.com', makePrimary: true }, 'https://server.example')
  expect(result).toMatchObject({ applied: true, request: { status: 'complete' } })
  expect(cf.connectAppDomain).toHaveBeenCalledWith('kept', 'a'.repeat(32), 'llll-server', expect.objectContaining({ id: 'zone' }), 'chat.example.com')
  expect(cf.setPrimaryAppDomain).toHaveBeenCalled()
  expect(db.prepare('SELECT origin FROM server_domains WHERE is_primary=1').get()).toEqual({ origin: 'https://chat.example.com' })
})

it('records a failed change so Settings can show why', async () => {
  const { connectManagedAppDomain } = await import('../../server/utils/server-infrastructure')
  cf.connectAppDomain.mockRejectedValueOnce(Object.assign(new Error('chat.example.com is already attached to Worker other'), { statusCode: 409 }))
  await expect(connectManagedAppDomain(env, { hostname: 'chat.example.com' }, 'https://server.example')).rejects.toThrow(/already attached/u)
  expect(db.prepare('SELECT status, error FROM server_domain_requests').get()).toEqual({ status: 'failed', error: 'chat.example.com is already attached to Worker other' })
})

it('connects a mail domain into D1 and disconnects it again', async () => {
  const { connectManagedEmailDomain, disconnectManagedEmailDomain } = await import('../../server/utils/server-infrastructure')
  cf.connectEmailDomain.mockImplementation(async (_t, _a, _w, _z, value: { id: string, domain: string }) => ({ ...value, sendingEnabled: true }))
  const connected = await connectManagedEmailDomain(env, { zoneId: 'zone', domain: 'example.com' })
  expect(connected).toMatchObject({ domain: 'example.com', zoneName: 'example.com', sendingEnabled: true })
  expect(db.prepare('SELECT domain, app_hostname AS host FROM email_domains').get()).toEqual({ domain: 'example.com', host: 'server.example' })
  await disconnectManagedEmailDomain(env, connected.id)
  expect(cf.disconnectEmailDomain).toHaveBeenCalled()
  expect(db.prepare('SELECT count(*) AS n FROM email_domains').get()).toEqual({ n: 0 })
})
