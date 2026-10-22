import { DatabaseSync } from 'node:sqlite'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import type { H3Event } from 'h3'
const context = vi.hoisted(() => ({ body: {} as Record<string, unknown>, owner: true, stored: null as string | null, revision: 0, env: {} as Record<string, unknown> }))
vi.mock('../../server/utils/guards', () => ({ requireMember: async () => ({ isOwner: context.owner, user: { id: 'owner' } }) }))
vi.mock('../../server/utils/messages', () => ({ writeAudit: vi.fn(async () => {}) }))
vi.mock('../../server/utils/releases', () => ({ llllReleases: vi.fn(async () => [{ tagName: 'v0.3.0' }]) }))
vi.mock('../../server/utils/cf', () => ({
  fail: (statusCode: number, code: string, message: string) => { throw Object.assign(Error(message), { statusCode, code }) },
  cf: () => ({ env: context.env }),
}))
const requestId = '22222222-2222-4222-8222-222222222222'
beforeEach(() => {
  context.body = { requestId, release: 'v0.3.0' }; context.owner = true; context.stored = null; context.revision = 0
  context.env = {
    DB: { withSession: () => ({ prepare: (sql: string) => ({ bind: (...params: (string | number)[]) => ({
      all: async () => {
        const database = new DatabaseSync(':memory:')
        try {
          database.exec('CREATE TABLE server_update_control(id INTEGER PRIMARY KEY, revision INTEGER, payload TEXT)')
          if (context.stored) database.prepare('INSERT INTO server_update_control VALUES(1,?,?)').run(context.revision, context.stored)
          const results = database.prepare(sql).all(...params)
          const row = database.prepare('SELECT payload,revision FROM server_update_control').get()
          context.stored = row?.payload as string ?? null; context.revision = row?.revision as number ?? 0
          return { results }
        } finally { database.close() }
      },
      first: async () => null,
    }) }) }) },
    FILES: {}, BACKUPS: {}, PUBLIC_ORIGIN: 'https://server.example', ACCOUNT_ID: 'a'.repeat(32), LLLL_WORKER_NAME: 'llll-test-worker',
  }
  vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
  vi.stubGlobal('getRouterParam', () => 'server')
  vi.stubGlobal('readBody', async () => context.body)
  vi.stubGlobal('getRequestURL', () => new URL('https://server.example'))
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ success: true })))
})
afterEach(() => vi.unstubAllGlobals())
async function request() { return (await import('../../server/api/servers/[id]/updates/request.post')).default({} as H3Event) }
async function resume() { return (await import('../../server/api/servers/[id]/updates/resume.post')).default({} as H3Event) }
it('accepts only an owner-selected newer published release and keeps capabilities private', async () => {
  const first = await request(), second = await request()
  expect(first.job!.id).toBe(requestId); expect(second.job!.id).toBe(requestId)
  expect(fetch).not.toHaveBeenCalled()
  expect(JSON.stringify(first)).not.toContain('backupToken')
  expect(JSON.parse(context.stored!).backupToken).toMatch(/^[a-f0-9]{64}$/)
  expect(JSON.stringify(first)).not.toContain(JSON.parse(context.stored!).backupToken)
})
it('rejects non-owners, downgrades and unpublished targets', async () => {
  context.owner = false; await expect(request()).rejects.toMatchObject({ statusCode: 403 })
  context.owner = true; context.body.release = 'v0.2.5'; await expect(request()).rejects.toMatchObject({ statusCode: 400 })
  context.body.release = 'v0.3.1'; await expect(request()).rejects.toMatchObject({ statusCode: 400 })
  expect(context.stored).toBeNull()
})
it('returns the official installer launch URL and lets the owner resume or cancel a queued request', async () => {
  const first = await request()
  const url = new URL(first.launchUrl!)
  expect(url.origin).toBe('https://llll.gg')
  expect(url.searchParams.get('server')).toBe('https://server.example')
  expect(url.searchParams.get('account')).toBe('a'.repeat(32))
  expect(url.searchParams.get('worker')).toMatch(/^llll-/)
  expect(url.searchParams.get('update')).toBe(requestId)
  const second = await request()
  expect(second.job!.id).toBe(requestId)
  expect(second.launchUrl).toBe(first.launchUrl)
  context.body = { requestId }
  const resumed = await resume()
  expect(resumed.job!.stage).toBe('queued')
  context.body = { requestId, cancel: true }
  await resume()
  expect(JSON.parse(context.stored!).job.stage).toBe('cancelled')
  expect(JSON.parse(context.stored!).backupToken).toBeNull()
})
it('refuses a resume when the request is already claimed and refuses updates without the installer grant', async () => {
  context.env.ACCOUNT_ID = ''
  context.env.LLLL_RUNTIME = 'celld'
  context.body = { requestId, release: 'v0.3.0' }
  await expect(request()).rejects.toMatchObject({ statusCode: 409 })
})
