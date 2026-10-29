import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { d1 } from '../helpers/sqlite-d1'
import { acceptCloudflareHandoff, cloudflareAccessStatus, cloudflareAccessToken, CLOUDFLARE_HANDOFF_KEY, disconnectCloudflareAccess, saveCloudflareToken } from '../../server/utils/cloudflare-account-access'
import { sha256Hex } from '../../shared/server-settings'
import type { L4Env } from '../../workers/env'

const account = 'a'.repeat(32)
let db: DatabaseSync, env: L4Env
const ok = vi.fn(async () => Response.json({ success: true }))
beforeEach(() => {
  db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE server_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at TEXT NOT NULL)')
  env = { DB: d1(db), AUTH_SECRET: 'test-auth-secret-for-this-server-only', ACCOUNT_ID: account } as unknown as L4Env
  ok.mockClear()
})
afterEach(() => db.close())
const grant = (expiresAt: number, accessToken = 'access-1') => ({ accessToken, refreshToken: 'refresh-1', expiresAt, clientId: 'client' })
async function offer(token: string, expires = Date.now() + 60000) {
  db.prepare('INSERT OR REPLACE INTO server_settings VALUES(?,?,?)').run(CLOUDFLARE_HANDOFF_KEY, `${await sha256Hex(token)}:${expires}`, new Date().toISOString())
}

it('accepts one installer handoff, encrypts it and never shows the grant', async () => {
  const token = 'b'.repeat(64)
  await offer(token)
  await acceptCloudflareHandoff(env, token, { grant: grant(Date.now() + 3600_000), accountId: account }, ok)
  expect(ok).toHaveBeenCalledWith(`https://api.cloudflare.com/client/v4/accounts/${account}`, expect.anything())
  expect(JSON.stringify(db.prepare('SELECT * FROM server_settings').all())).not.toMatch(/access-1|refresh-1/u)
  expect(await cloudflareAccessStatus(env)).toMatchObject({ connected: true, kind: 'oauth', accountId: account })
  await expect(acceptCloudflareHandoff(env, token, { grant: grant(Date.now()), accountId: account }, ok)).rejects.toMatchObject({ statusCode: 403 })
  expect((await cloudflareAccessToken(env)).token).toBe('access-1')
})

it('refuses an expired, wrong or foreign-account handoff before calling Cloudflare', async () => {
  await offer('c'.repeat(64), Date.now() - 1)
  await expect(acceptCloudflareHandoff(env, 'c'.repeat(64), { grant: grant(0), accountId: account }, ok)).rejects.toMatchObject({ statusCode: 403 })
  await offer('d'.repeat(64))
  await expect(acceptCloudflareHandoff(env, 'e'.repeat(64), { grant: grant(0), accountId: account }, ok)).rejects.toMatchObject({ statusCode: 403 })
  await expect(acceptCloudflareHandoff(env, 'd'.repeat(64), { grant: grant(0), accountId: 'f'.repeat(32) }, ok)).rejects.toMatchObject({ statusCode: 400 })
  await expect(acceptCloudflareHandoff(env, 'd'.repeat(64), {}, ok)).rejects.toMatchObject({ statusCode: 400 })
  expect(ok).not.toHaveBeenCalled()
  expect(await cloudflareAccessStatus(env)).toEqual({ connected: false })
})

it('refreshes an expiring grant once and keeps the rotated one', async () => {
  await offer('b'.repeat(64))
  await acceptCloudflareHandoff(env, 'b'.repeat(64), { grant: grant(Date.now() + 30_000), accountId: account }, ok)
  const refresh = vi.fn(async () => grant(Date.now() + 3600_000, 'access-2'))
  expect((await cloudflareAccessToken(env, refresh)).token).toBe('access-2')
  expect((await cloudflareAccessToken(env, refresh)).token).toBe('access-2')
  expect(refresh).toHaveBeenCalledTimes(1)
  const failing = vi.fn(async () => { throw new Error('revoked') })
  db.prepare("UPDATE server_settings SET value=value WHERE key='cloudflare.access'").run()
  await disconnectCloudflareAccess(env)
  await expect(cloudflareAccessToken(env, failing)).rejects.toMatchObject({ data: { error: { code: 'cloudflare_access_missing' } } })
})

it('stores a pasted token only when it reaches this account', async () => {
  const denied = vi.fn(async () => new Response(null, { status: 403 }))
  await expect(saveCloudflareToken(env, account, 'token-with-enough-length', denied)).rejects.toMatchObject({ statusCode: 400 })
  await saveCloudflareToken(env, account, 'token-with-enough-length', ok)
  expect(await cloudflareAccessStatus(env)).toMatchObject({ connected: true, kind: 'token' })
  expect((await cloudflareAccessToken(env)).token).toBe('token-with-enough-length')
})

it('renews a kept grant weekly even before it expires, and ignores pasted tokens', async () => {
  const { renewCloudflareAccess } = await import('../../server/utils/cloudflare-account-access')
  const refresh = vi.fn(async () => grant(Date.now() + 3600_000, 'access-weekly'))
  expect(await renewCloudflareAccess(env, refresh)).toBe(false)
  await offer('b'.repeat(64))
  await acceptCloudflareHandoff(env, 'b'.repeat(64), { grant: grant(Date.now() + 3600_000), accountId: account }, ok)
  expect(await renewCloudflareAccess(env, refresh)).toBe(true)
  expect(refresh).toHaveBeenCalledTimes(1)
  expect((await cloudflareAccessToken(env)).token).toBe('access-weekly')
})
