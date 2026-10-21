import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { deployL4Update, type InstallerReleaseManifest } from '../../../packages/deployment-core/src/index'

const asset = { url: 'https://releases.example/asset', sha256: 'a'.repeat(64), size: 0 }
const manifest: InstallerReleaseManifest = {
  schemaVersion: 1, version: '0.2.4', releasedAt: '2026-10-21',
  compatibilityDate: '2026-10-16', compatibilityFlags: ['nodejs_compat'],
  worker: asset, assets: asset,
  durableObjects: [
    { binding: 'CHANNEL_DO', className: 'ChannelDurableObject', migration: 'v1' },
    { binding: 'AGENT_RUN', className: 'AgentRun', migration: 'v2' },
  ],
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

function fixture(upload: (attempt: number) => Response) {
  const requests: Array<{ path: string; body: unknown; at: number }> = []
  let installedVersion = '0.2.2'
  let uploads = 0
  let databaseId = 'original-database'
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname
    let result: unknown
    requests.push({ path, body: init?.body, at: Date.now() })
    if (path === '/api/setup/health') return Response.json({ ok: true, ready: true, migrated: true, version: installedVersion })
    if (path === '/client/v4/accounts/account') result = { id: 'account' }
    else if (path.endsWith('/workers/scripts')) result = [{ id: 'community', migration_tag: installedVersion === manifest.version ? 'v2' : 'v1' }]
    else if (path.endsWith('/settings')) result = { bindings: [
      { name: 'LLLL_SERVER_MARKER', type: 'plain_text', text: 'llll.gg/server-v1' },
      { name: 'LLLL_APP_HOSTNAME', type: 'plain_text', text: 'community.example.com' },
      { name: 'LLLL_VERSION', type: 'plain_text', text: installedVersion },
      { name: 'DB', type: 'd1', database_id: databaseId },
      { name: 'CHANNEL_DO', type: 'durable_object_namespace', class_name: 'ChannelDurableObject' },
    ] }
    else if (path.endsWith('/query')) result = [{ results: [] }]
    else if (path.endsWith('/assets-upload-session')) result = { jwt: 'asset-completion', buckets: [] }
    else if (path.endsWith('/workers/scripts/community') && init?.method === 'PUT') {
      const response = upload(++uploads)
      if (response.ok && (await response.clone().json()).success === true) installedVersion = manifest.version
      return response
    }
    else throw new Error(`Unexpected Cloudflare request: ${path}`)
    return Response.json({ success: true, result, result_info: { page: 1, total_pages: 1 } })
  }))
  const run = (verify = false) => deployL4Update('private-token', 'account', 'community', {
    manifest, worker: new TextEncoder().encode('export default {}').buffer,
    assets: { assets: [], migrations: [{ name: '0000_test.sql', sql: 'CREATE TABLE example (id TEXT);' }] },
  }, { verify })
  return { run, requests, installed: (value: string) => { installedVersion = value }, database: (value: string) => { databaseId = value } }
}
const success = () => Response.json({ success: true, result: {} })
const failure = (status: number, headers?: HeadersInit) => Response.json({ success: false, errors: [{ message: 'Internal authentication error: internal server error' }] }, { status, headers })

it.each([408, 429, 500, 502, 503, 504])('retries HTTP %i without repeating D1 migrations or asset preparation', async status => {
  const f = fixture(attempt => attempt === 1 ? failure(status) : success())
  const result = f.run(true)
  const assertion = expect(result).resolves.toMatchObject({ version: '0.2.4', updated: true })
  await Promise.all([assertion, vi.runAllTimersAsync()])
  const uploads = f.requests.filter(r => r.path.endsWith('/workers/scripts/community'))
  expect(uploads).toHaveLength(2)
  expect(uploads[1]!.at - uploads[0]!.at).toBeGreaterThanOrEqual(1000)
  expect(uploads[0]!.body).not.toBe(uploads[1]!.body)
  for (const request of uploads) {
    const form = request.body as FormData
    expect(await (form.get('llll-worker.mjs') as Blob).text()).toBe('export default {}')
    expect(JSON.parse(String(form.get('metadata'))).migrations).toEqual({ old_tag: 'v1', new_tag: 'v2', steps: [{ new_sqlite_classes: ['AgentRun'] }] })
  }
  expect(f.requests.filter(r => r.path.endsWith('/query'))).toHaveLength(3)
  expect(f.requests.filter(r => r.path.endsWith('/assets-upload-session'))).toHaveLength(1)
})

it('reconciles a successful upload whose response was 500 instead of uploading it again', async () => {
  const f = fixture(() => { f.installed(manifest.version); return failure(500) })
  const result = f.run(true)
  const assertion = expect(result).resolves.toMatchObject({ version: '0.2.4', updated: true })
  await Promise.all([assertion, vi.runAllTimersAsync()])
  expect(f.requests.filter(r => r.path.endsWith('/workers/scripts/community'))).toHaveLength(1)
  expect(f.requests.filter(r => r.path.endsWith('/settings'))).toHaveLength(2)
  expect(f.requests.filter(r => r.path.endsWith('/api/setup/health'))).toHaveLength(1)
})

it('does not retry a failure envelope returned with HTTP 200', async () => {
  const f = fixture(() => Response.json({ success: false, errors: [{ message: 'Invalid upload' }] }))
  await expect(f.run()).rejects.toMatchObject({ statusCode: 502 })
  expect(f.requests.filter(r => r.path.endsWith('/workers/scripts/community'))).toHaveLength(1)
})

it('retries a temporary non-JSON gateway response', async () => {
  const f = fixture(attempt => attempt === 1 ? new Response('Bad Gateway', { status: 502 }) : success())
  const assertion = expect(f.run()).resolves.toMatchObject({ updated: true })
  await Promise.all([assertion, vi.runAllTimersAsync()])
  expect(f.requests.filter(r => r.path.endsWith('/workers/scripts/community'))).toHaveLength(2)
})

it.each([400, 401, 403, 409, 422])('does not retry permanent HTTP %i failures', async status => {
  const f = fixture(() => failure(status))
  await expect(f.run()).rejects.toMatchObject({ statusCode: status })
  expect(f.requests.filter(r => r.path.endsWith('/workers/scripts/community'))).toHaveLength(1)
  expect(vi.getTimerCount()).toBe(0)
})

it('stops after four total upload attempts and preserves the Cloudflare error', async () => {
  const f = fixture(() => failure(503))
  const result = f.run()
  const assertion = expect(result).rejects.toMatchObject({ statusCode: 503, statusMessage: 'Internal authentication error: internal server error' })
  await Promise.all([assertion, vi.runAllTimersAsync()])
  expect(f.requests.filter(r => r.path.endsWith('/workers/scripts/community'))).toHaveLength(4)
})

it('reconciles a successful fourth upload even when its response is 500', async () => {
  const f = fixture(attempt => { if (attempt === 4) f.installed(manifest.version); return failure(500) })
  const assertion = expect(f.run()).resolves.toMatchObject({ updated: true })
  await Promise.all([assertion, vi.runAllTimersAsync()])
  expect(f.requests.filter(r => r.path.endsWith('/workers/scripts/community'))).toHaveLength(4)
})

it('honors Retry-After before retrying a rate limited upload', async () => {
  const f = fixture(attempt => attempt === 1 ? failure(429, { 'Retry-After': '8' }) : success())
  const result = f.run()
  const assertion = expect(result).resolves.toMatchObject({ updated: true })
  await Promise.all([assertion, vi.runAllTimersAsync()])
  const uploads = f.requests.filter(r => r.path.endsWith('/workers/scripts/community'))
  expect(uploads).toHaveLength(2)
  expect(uploads[1]!.at - uploads[0]!.at).toBeGreaterThanOrEqual(8000)
})

it('honors a Retry-After HTTP date', async () => {
  const retryAt = new Date(Date.now() + 10_000).toUTCString()
  const f = fixture(attempt => attempt === 1 ? failure(503, { 'Retry-After': retryAt }) : success())
  const assertion = expect(f.run()).resolves.toMatchObject({ updated: true })
  await Promise.all([assertion, vi.runAllTimersAsync()])
  const uploads = f.requests.filter(r => r.path.endsWith('/workers/scripts/community'))
  expect(uploads[1]!.at).toBeGreaterThanOrEqual(Date.parse(retryAt))
})

it.each([{ 'Retry-After': '120' }, { 'x-should-retry': 'false' }])('stops when Cloudflare prohibits a bounded retry: %j', async headers => {
  const f = fixture(() => failure(503, headers))
  await expect(f.run()).rejects.toMatchObject({ statusCode: 503 })
  expect(f.requests.filter(r => r.path.endsWith('/workers/scripts/community'))).toHaveLength(1)
})

it('does not automatically replay an upload with an unknown transport outcome', async () => {
  const f = fixture(() => { throw new TypeError('fetch failed') })
  await expect(f.run()).rejects.toThrow('fetch failed')
  expect(f.requests.filter(r => r.path.endsWith('/workers/scripts/community'))).toHaveLength(1)
})

it('stops if a different Server version was installed before retrying', async () => {
  const f = fixture(() => { f.installed('0.2.5'); return failure(500) })
  const assertion = expect(f.run()).rejects.toThrow(/version changed/i)
  await Promise.all([assertion, vi.runAllTimersAsync()])
  expect(f.requests.filter(r => r.path.endsWith('/workers/scripts/community'))).toHaveLength(1)
})

it('stops if the Server database changed before retrying', async () => {
  const f = fixture(() => { f.database('different-database'); return failure(500) })
  const result = f.run()
  const assertion = expect(result).rejects.toThrow(/changed/i)
  await Promise.all([assertion, vi.runAllTimersAsync()])
  expect(f.requests.filter(r => r.path.endsWith('/workers/scripts/community'))).toHaveLength(1)
})
