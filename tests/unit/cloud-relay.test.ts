import { describe, expect, it, vi } from 'vitest'
import { cloudRelay, purgeServerFiles } from '../../server/utils/cloud-relay'
import type { L4Env } from '../../workers/env'

const SECRET = 'cloud-secret-'.repeat(3)

function fakeFiles(keys: string[]) {
  const objects = new Set(keys)
  return {
    objects,
    bucket: {
      async list({ limit = 1000, cursor }: { limit?: number; cursor?: string }) {
        const all = [...objects].sort()
        const start = cursor ? all.indexOf(cursor) + 1 : 0
        const page = all.slice(start, start + limit)
        const truncated = start + limit < all.length
        return { objects: page.map(key => ({ key })), truncated, cursor: truncated ? page.at(-1) : undefined }
      },
      async delete(key: string | string[]) { for (const item of Array.isArray(key) ? key : [key]) objects.delete(item) },
    } as unknown as R2Bucket,
  }
}

const env = (extra: Partial<L4Env> = {}) => ({ LLLL_RUNTIME: 'cloud', CLOUD_SECRET: SECRET, ...extra }) as L4Env
const call = (path: string, init: RequestInit = {}, e: L4Env = env(), scheduled = vi.fn(async () => {})) =>
  cloudRelay(new Request(`https://acme.llll.gg${path}`, init), e, path, scheduled).then(response => ({ response, scheduled }))

describe('the L4 Cloud relay', () => {
  it('answers nothing outside its prefix', async () => {
    expect((await call('/api/setup/health')).response).toBeNull()
  })

  it('is 404 without the right bearer secret, the right method, or the cloud runtime', async () => {
    expect((await call('/.llll/cloud/scheduled', { method: 'POST' })).response?.status).toBe(404)
    expect((await call('/.llll/cloud/scheduled', { method: 'POST', headers: { authorization: `Bearer ${SECRET}x` } })).response?.status).toBe(404)
    expect((await call('/.llll/cloud/scheduled', { method: 'GET', headers: { authorization: `Bearer ${SECRET}` } })).response?.status).toBe(404)
    expect((await call('/.llll/cloud/scheduled', { method: 'POST', headers: { authorization: `Bearer ${SECRET}` } }, env({ LLLL_RUNTIME: 'cloudflare' }))).response?.status).toBe(404)
    expect((await call('/.llll/cloud/scheduled', { method: 'POST', headers: { authorization: `Bearer ${SECRET}` } }, env({ CLOUD_SECRET: undefined }))).response?.status).toBe(404)
    expect((await call('/.llll/cloud/other', { method: 'POST', headers: { authorization: `Bearer ${SECRET}` } })).response?.status).toBe(404)
  })

  it('runs the scheduled work for the control plane', async () => {
    const { response, scheduled } = await call('/.llll/cloud/scheduled', { method: 'POST', headers: { authorization: `Bearer ${SECRET}` } })
    expect(response?.status).toBe(200)
    expect(scheduled).toHaveBeenCalledOnce()
  })

  it('empties the files bucket, page by page, before the control plane deletes it', async () => {
    const files = fakeFiles(Array.from({ length: 1203 }, (_, index) => `files/${String(index).padStart(5, '0')}`))
    const { response } = await call('/.llll/cloud/purge-files', { method: 'POST', headers: { authorization: `Bearer ${SECRET}` } }, env({ FILES: files.bucket }))
    expect(await response?.json()).toEqual({ ok: true, deleted: 1203 })
    expect(files.objects.size).toBe(0)
    expect(await purgeServerFiles(env())).toBe(0)
  })
})
