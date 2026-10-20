import { afterEach, expect, it, vi } from 'vitest'
import { listL4Servers } from '../../packages/deployment-core/src/servers'

afterEach(() => vi.unstubAllGlobals())

it('discovers arbitrary Worker names by the Server marker and excludes unrelated llll Workers', async () => {
  vi.stubGlobal('fetch', vi.fn(async (input: Request | string) => {
    const url = new URL(typeof input === 'string' ? input : input.url)
    if (url.pathname.endsWith('/workers/scripts')) return Response.json({ success: true, result: [{ id: 'community' }, { id: 'llll-unrelated' }] })
    return Response.json({ success: true, result: { bindings: [
      { type: 'plain_text', name: 'LLLL_SERVER_MARKER', text: url.pathname.includes('/community/') ? 'llll.gg/server-v1' : 'another-product' },
      { type: 'plain_text', name: 'LLLL_APP_HOSTNAME', text: 'community.customer.workers.dev' },
      { type: 'plain_text', name: 'APP_NAME', text: 'Community' },
    ] } })
  }))
  const servers = await listL4Servers('private-access', 'a'.repeat(32), { zones: [], strict: true })
  expect(servers.map(server => server.workerName)).toEqual(['community'])
  expect(servers[0]?.origin).toBe('https://community.customer.workers.dev')
})

it('reports denied settings access instead of showing a falsely empty inventory', async () => {
  vi.stubGlobal('fetch', vi.fn(async (input: Request | string) => {
    const url = new URL(typeof input === 'string' ? input : input.url)
    if (url.pathname.endsWith('/workers/scripts')) return Response.json({ success: true, result: [{ id: 'community' }] })
    return Response.json({ success: false, errors: [{ message: 'Access denied' }] }, { status: 403 })
  }))
  await expect(listL4Servers('private-access', 'a'.repeat(32), { zones: [], strict: true })).rejects.toMatchObject({ status: 403 })
})
