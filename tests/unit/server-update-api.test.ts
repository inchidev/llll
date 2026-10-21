import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import type { H3Event } from 'h3'
const context = vi.hoisted(() => ({ body: {} as Record<string, unknown>, owner: true, stored: null as string | null, etag: 0 }))
vi.mock('../../server/utils/guards', () => ({ requireMember: async () => ({ isOwner: context.owner, user: { id: 'owner' } }) }))
vi.mock('../../server/utils/messages', () => ({ writeAudit: vi.fn(async () => {}) }))
vi.mock('../../server/utils/releases', () => ({ llllReleases: vi.fn(async () => [{ tagName: 'v0.2.2' }]) }))
vi.mock('../../server/utils/cf', () => ({
  fail: (statusCode: number, code: string, message: string) => { throw Object.assign(Error(message), { statusCode, code }) },
  cf: () => ({ env: {
    DB: {}, FILES: {}, LLLL_VERSION: '0.2.1', LLLL_ACCOUNT_ID: 'a'.repeat(32), LLLL_WORKER_NAME: 'worker', LLLL_SERVER_MARKER: 'llll.gg/server-v1', LLLL_UPDATE_HOOK: '11111111-1111-4111-8111-111111111111', BACKUP_BUCKET_NAME: 'separate-backups',
    BACKUPS: {
      async get() { return context.stored ? { etag: String(context.etag), text: async () => context.stored } : null },
      async put(_key: string, value: string, options: { onlyIf: { etagMatches?: string; etagDoesNotMatch?: string } }) {
        if (options.onlyIf.etagMatches && options.onlyIf.etagMatches !== String(context.etag)) return null
        if (options.onlyIf.etagDoesNotMatch === '*' && context.stored) return null
        context.stored = value; context.etag++; return { etag: String(context.etag) }
      },
    },
  } }),
}))
const requestId = '22222222-2222-4222-8222-222222222222'
beforeEach(() => {
  context.body = { requestId, release: 'v0.2.2' }; context.owner = true; context.stored = null; context.etag = 0
  vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
  vi.stubGlobal('getRouterParam', () => 'server')
  vi.stubGlobal('readBody', async () => context.body)
  vi.stubGlobal('getRequestURL', () => new URL('https://server.example'))
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ success: true })))
})
afterEach(() => vi.unstubAllGlobals())
async function request() { return (await import('../../server/api/servers/[id]/updates/request.post')).default({} as H3Event) }
async function resume() { return (await import('../../server/api/servers/[id]/updates/resume.post')).default({} as H3Event) }
it('accepts only an owner-selected newer published release, deduplicates retries and keeps capabilities private', async () => {
  const first = await request(), second = await request()
  expect(first.job!.id).toBe(requestId); expect(second.job!.id).toBe(requestId)
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(vi.mocked(fetch).mock.calls[0]![0]).toBe('https://api.cloudflare.com/client/v4/workers/builds/deploy_hooks/11111111-1111-4111-8111-111111111111')
  expect(JSON.stringify(first)).not.toContain('backupToken')
  expect(JSON.parse(context.stored!).backupToken).toMatch(/^[a-f0-9]{64}$/)
  expect(JSON.stringify(first)).not.toContain(JSON.parse(context.stored!).backupToken)
})
it('rejects non-owners, downgrades and unpublished targets before starting a Build', async () => {
  context.owner = false; await expect(request()).rejects.toMatchObject({ statusCode: 403 })
  context.owner = true; context.body.release = 'v0.2.0'; await expect(request()).rejects.toMatchObject({ statusCode: 400 })
  context.body.release = 'v0.3.0'; await expect(request()).rejects.toMatchObject({ statusCode: 400 })
  expect(fetch).not.toHaveBeenCalled(); expect(context.stored).toBeNull()
})
it('keeps an ambiguous hook timeout queued, resumes the same request, and cancels only before a Build claims it', async () => {
  vi.mocked(fetch).mockRejectedValueOnce(Error('private secret must not appear'))
  const queued = await request()
  expect(queued.job!.stage).toBe('queued'); expect(queued.job!.error).not.toContain('private secret')
  await request(); expect(fetch).toHaveBeenCalledTimes(1)
  context.body = { requestId }; await resume(); expect(fetch).toHaveBeenCalledTimes(2)
  const record = JSON.parse(context.stored!); record.job.stage = 'backing_up'; context.stored = JSON.stringify(record)
  context.body = { requestId, cancel: true }; await expect(resume()).rejects.toMatchObject({ statusCode: 409 })
  record.job.stage = 'queued'; context.stored = JSON.stringify(record)
  await resume(); expect(JSON.parse(context.stored!).job.stage).toBe('cancelled'); expect(JSON.parse(context.stored!).backupToken).toBeNull()
})
