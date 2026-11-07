import { afterEach, describe, expect, it, vi } from 'vitest'
import { deleteHostedL4, hostedResourceNames, hostedWorkerBindings, installHostedL4, parseHostedInstallRequest } from '../../../packages/deployment-core/src/hosted'
import { scriptApiPath } from '../../../packages/deployment-core/src/deploy'

const ACCOUNT = 'a'.repeat(32)
const SERVER = '3f2b8c1e-5d4a-4e6f-9a7b-1c2d3e4f5a6b'
const API = 'https://api.cloudflare.com/client/v4'
const RELEASES = 'https://releases.test'

async function sha256(value: string | ArrayBuffer) {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value)
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

// A tiny release, with hashes the loader checks, like a published one.
async function fakeRelease() {
  const worker = 'export default { fetch() { return new Response("ok") } }'
  const assets = JSON.stringify({
    assets: [{ path: '/index.html', hash: 'ab'.repeat(16), size: 6, contentType: 'text/html', contentBase64: btoa('<p>hi') }],
    migrations: [{ name: '0000_baseline', sql: 'CREATE TABLE server_schema (id INTEGER PRIMARY KEY, version TEXT);' }],
  })
  const manifest = {
    schemaVersion: 1, version: '0.0.9', releasedAt: '2026-11-07', compatibilityDate: '2026-10-16', compatibilityFlags: ['nodejs_compat'],
    capabilities: ['llll-server-schema-v1', 'optional-r2'],
    worker: { url: `${RELEASES}/worker.mjs`, sha256: await sha256(worker), size: worker.length },
    assets: { url: `${RELEASES}/assets.json`, sha256: await sha256(assets), size: assets.length },
    durableObjects: [{ binding: 'SERVER_DO', className: 'ServerDurableObject', migration: 'v1' }, { binding: 'CHANNEL_DO', className: 'ChannelDurableObject', migration: 'v1' }],
  }
  return { manifest, worker, assets }
}

type Call = { method: string; url: string; body: unknown }

// Answers the release files and Cloudflare's API, and keeps every call.
function fakeNetwork(release: Awaited<ReturnType<typeof fakeRelease>>, options: { scriptExists?: boolean; d1Missing?: boolean } = {}) {
  const calls: Call[] = []
  const ok = (result: unknown) => Response.json({ success: true, result })
  const missing = () => Response.json({ success: false, errors: [{ code: 10007, message: 'not found' }] }, { status: 404 })
  const fetcher = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input instanceof Request ? input.url : input)
    const method = (init.method || 'GET').toUpperCase()
    let body: unknown = init.body
    if (init.body instanceof FormData) body = Object.fromEntries([...init.body.entries()].map(([key, value]) => [key, typeof value === 'string' ? value : `<${(value as Blob).type}>`]))
    else if (typeof init.body === 'string') { try { body = JSON.parse(init.body) } catch { /* text */ } }
    calls.push({ method, url, body })
    if (url === `${RELEASES}/manifest.json`) return Response.json(release.manifest)
    if (url === `${RELEASES}/worker.mjs`) return new Response(release.worker)
    if (url === `${RELEASES}/assets.json`) return new Response(release.assets)
    if (url === 'https://acme.llll.gg/api/setup/health') return Response.json({ version: '0.0.9', ok: true, migrated: true, ready: false })
    if (url === 'https://acme.llll.gg/.llll/cloud/purge-files') return Response.json({ ok: true, deleted: 3 })
    const path = url.slice(API.length)
    if (path === `/accounts/${ACCOUNT}/d1/database` && method === 'POST') return ok({ uuid: 'd1-uuid', name: (body as { name: string }).name })
    if (path === `/accounts/${ACCOUNT}/r2/buckets` && method === 'POST') return ok({})
    if (path === `/accounts/${ACCOUNT}/storage/kv/namespaces` && method === 'POST') return ok({ id: 'kv-id' })
    if (path.startsWith(`/accounts/${ACCOUNT}/d1/database/`) && path.endsWith('/query')) {
      const sql = String((body as { sql: string }).sql)
      return ok(sql.startsWith('SELECT name FROM d1_migrations') ? [{ success: true, results: [] }] : [{ success: true }])
    }
    if (path.endsWith('/assets-upload-session')) return ok({ jwt: 'session-jwt', buckets: [['ab'.repeat(16)]] })
    if (path === `/accounts/${ACCOUNT}/workers/assets/upload?base64=true`) return ok({ jwt: 'completion-jwt' })
    if (path.endsWith(`/scripts/srv-${SERVER}/settings`)) return options.scriptExists ? ok({ bindings: [] }) : missing()
    if (path.endsWith(`/scripts/srv-${SERVER}`) && method === 'PUT') return ok({ id: `srv-${SERVER}` })
    if (path.endsWith(`/scripts/srv-${SERVER}?force=true`) && method === 'DELETE') return ok(null)
    if (path === `/accounts/${ACCOUNT}/d1/database/d1-uuid` && method === 'DELETE') return options.d1Missing ? missing() : ok(null)
    if (path === `/accounts/${ACCOUNT}/storage/kv/namespaces/kv-id` && method === 'DELETE') return ok(null)
    if (path === `/accounts/${ACCOUNT}/r2/buckets/llll-srv-${SERVER}-files` && method === 'DELETE') return ok(null)
    return Response.json({ success: false, errors: [{ message: `unexpected ${method} ${url}` }] }, { status: 500 })
  })
  return { fetcher, calls }
}

afterEach(() => vi.unstubAllGlobals())

const request = { accountId: ACCOUNT, namespace: 'llll-cloud', serverId: SERVER, name: 'Acme', hostname: 'acme.llll.gg' }

describe('a Server on L4 Cloud', () => {
  it('names its script and resources after its UUID, in the dispatch namespace', () => {
    expect(scriptApiPath(ACCOUNT, 'srv-1', { namespace: 'llll-cloud' })).toBe(`/accounts/${ACCOUNT}/workers/dispatch/namespaces/llll-cloud/scripts/srv-1`)
    expect(scriptApiPath(ACCOUNT, 'llll-1')).toBe(`/accounts/${ACCOUNT}/workers/scripts/llll-1`)
    expect(() => scriptApiPath(ACCOUNT, 'x', { namespace: 'Bad Name' })).toThrow()
    expect(hostedResourceNames(SERVER)).toEqual({ database: `llll-srv-${SERVER}-db`, files: `llll-srv-${SERVER}-files`, backups: `llll-srv-${SERVER}-backups`, tickets: `llll-srv-${SERVER}-tickets` })
    expect(() => parseHostedInstallRequest({ ...request, hostname: 'not a host' })).toThrow()
    expect(() => parseHostedInstallRequest({ ...request, serverId: 'nope' })).toThrow()
    expect(parseHostedInstallRequest({ ...request, targetVersion: 'v0.0.9' })).toMatchObject({ targetVersion: 'v0.0.9' })
  })

  it('binds its own storage and no account, no AI and no browser, and runs as cloud', () => {
    const bindings = hostedWorkerBindings({ durableObjects: [{ binding: 'SERVER_DO', className: 'ServerDurableObject', migration: 'v1' }] }, { databaseId: 'd1', filesBucket: 'files', backupBucket: 'backups', kvId: 'kv' }, 'https://acme.llll.gg', { authSecret: 'auth', cloudSecret: 'cloud' })
    const names = bindings.map(binding => binding.name)
    expect(names).toEqual(['DB', 'TICKETS', 'FILES', 'BACKUPS', 'ASSETS', 'PUBLIC_ORIGIN', 'AUTH_MODE', 'LLLL_RUNTIME', 'AUTH_SECRET', 'CLOUD_SECRET', 'SERVER_DO'])
    expect(bindings.find(binding => binding.name === 'LLLL_RUNTIME')).toEqual({ type: 'plain_text', name: 'LLLL_RUNTIME', text: 'cloud' })
    expect(bindings.filter(binding => binding.type === 'secret_text').map(binding => binding.name)).toEqual(['AUTH_SECRET', 'CLOUD_SECRET'])
    expect(names).not.toContain('ACCOUNT_ID')
    expect(names).not.toContain('AI')
    expect(names).not.toContain('BROWSER')
  })

  it('is installed from a verified release into the namespace, seeded, and verified at its hostname', async () => {
    const release = await fakeRelease()
    const { fetcher, calls } = fakeNetwork(release)
    vi.stubGlobal('fetch', fetcher)
    const steps: string[] = []
    const kept: unknown[] = []
    const result = await installHostedL4('token', request, { manifestUrl: `${RELEASES}/manifest.json`, fetch: fetcher, report: event => { steps.push(`${event.step}:${event.state}`) }, onStorage: resources => { kept.push(resources) } })
    expect(kept).toEqual([result.resources])

    expect(result).toMatchObject({ origin: 'https://acme.llll.gg', version: '0.0.9', scriptName: `srv-${SERVER}`, resources: { databaseId: 'd1-uuid', filesBucket: `llll-srv-${SERVER}-files`, backupBucket: `llll-srv-${SERVER}-backups`, kvId: 'kv-id' }, appliedMigrations: ['0000_baseline'], verified: true })
    expect(result.setupUrl).toMatch(/^https:\/\/acme\.llll\.gg\/setup#claim=[A-Za-z0-9_-]{32,}$/)
    expect(result.authSecret).not.toBe(result.cloudSecret)
    expect(steps.filter(step => step.endsWith(':complete')).map(step => step.split(':')[0])).toEqual(['release', 'storage', 'database', 'assets', 'worker', 'verify'])

    const upload = calls.find(call => call.method === 'PUT' && call.url.endsWith(`/scripts/srv-${SERVER}`))!
    expect(upload.url).toBe(`${API}/accounts/${ACCOUNT}/workers/dispatch/namespaces/llll-cloud/scripts/srv-${SERVER}`)
    const metadata = JSON.parse((upload.body as { metadata: string }).metadata)
    expect(metadata).toMatchObject({ main_module: 'llll-worker.mjs', compatibility_date: '2026-10-16', tags: ['llll-server', 'llll-cloud'], assets: { jwt: 'completion-jwt' }, migrations: { new_tag: 'v1' } })
    expect(metadata.compatibility_flags).toEqual(['nodejs_compat', 'global_fetch_strictly_public'])
    expect(metadata.bindings.map((binding: { name: string }) => binding.name)).toContain('CLOUD_SECRET')
    expect(metadata.bindings.find((binding: { name: string }) => binding.name === 'CLOUD_SECRET').text).toBe(result.cloudSecret)
    expect(metadata).not.toHaveProperty('placement')
    expect(metadata).not.toHaveProperty('observability')

    // Storage is made in the account; the assets session is the namespace's.
    expect(calls.filter(call => call.method === 'POST' && call.url.endsWith('/d1/database')).map(call => (call.body as { name: string }).name)).toEqual([`llll-srv-${SERVER}-db`])
    expect(calls.filter(call => call.url.endsWith('/r2/buckets')).map(call => (call.body as { name: string }).name).sort()).toEqual([`llll-srv-${SERVER}-backups`, `llll-srv-${SERVER}-files`])
    expect(calls.some(call => call.url === `${API}/accounts/${ACCOUNT}/workers/dispatch/namespaces/llll-cloud/scripts/srv-${SERVER}/assets-upload-session`)).toBe(true)
    // The database is migrated and seeded: identity, invite-only sign-in, backup bucket, the Owner's claim.
    const seeds = calls.filter(call => call.url.endsWith('/query')).map(call => String((call.body as { sql: string }).sql))
    expect(seeds.some(sql => sql.includes('CREATE TABLE server_schema'))).toBe(true)
    expect(seeds.some(sql => sql.includes('INSERT INTO server_identity'))).toBe(true)
    expect(seeds.some(sql => sql.includes('INSERT INTO server_setup'))).toBe(true)
    expect(calls.filter(call => call.url.endsWith('/query')).some(call => JSON.stringify((call.body as { params?: unknown[] }).params ?? []).includes('invite_only'))).toBe(true)
    expect(calls.filter(call => call.url.endsWith('/query')).some(call => JSON.stringify((call.body as { params?: unknown[] }).params ?? []).includes(`llll-srv-${SERVER}-backups`))).toBe(true)
    // No account-level step: no workers.dev subdomain, no custom domain, no cron, no Access.
    expect(calls.some(call => /subdomain|domains|schedules|access\/apps/.test(call.url))).toBe(false)
  })

  it('reuses what an earlier attempt made and replays no Durable Object migration', async () => {
    const release = await fakeRelease()
    const { fetcher, calls } = fakeNetwork(release, { scriptExists: true })
    vi.stubGlobal('fetch', fetcher)
    const resources = { databaseId: 'd1-uuid', filesBucket: `llll-srv-${SERVER}-files`, backupBucket: `llll-srv-${SERVER}-backups`, kvId: 'kv-id' }
    const result = await installHostedL4('token', request, { manifestUrl: `${RELEASES}/manifest.json`, fetch: fetcher, resources, authSecret: 'a'.repeat(48), cloudSecret: 'c'.repeat(32), setupToken: 's'.repeat(40), verify: false })
    expect(result).toMatchObject({ resources, authSecret: 'a'.repeat(48), cloudSecret: 'c'.repeat(32), verified: false })
    expect(result.setupUrl).toBe(`https://acme.llll.gg/setup#claim=${'s'.repeat(40)}`)
    expect(calls.some(call => call.method === 'POST' && /d1\/database$|r2\/buckets$|kv\/namespaces$/.test(call.url))).toBe(false)
    const upload = calls.find(call => call.method === 'PUT' && call.url.endsWith(`/scripts/srv-${SERVER}`))!
    expect(JSON.parse((upload.body as { metadata: string }).metadata)).not.toHaveProperty('migrations')
    expect(calls.some(call => call.url.endsWith('/api/setup/health'))).toBe(false)
  })

  it('is deleted with its script, database, files and KV, and never its backups', async () => {
    const release = await fakeRelease()
    const { fetcher, calls } = fakeNetwork(release, { d1Missing: true })
    vi.stubGlobal('fetch', fetcher)
    const result = await deleteHostedL4('token', { ...request, cloudSecret: 'c'.repeat(32), resources: { databaseId: 'd1-uuid', filesBucket: `llll-srv-${SERVER}-files`, backupBucket: `llll-srv-${SERVER}-backups`, kvId: 'kv-id' } }, fetcher)
    expect(result).toEqual({ purgedFiles: true, removed: ['script', 'kv', 'files'] })
    expect(calls[0]).toMatchObject({ method: 'POST', url: 'https://acme.llll.gg/.llll/cloud/purge-files' })
    expect(calls.filter(call => call.method === 'DELETE').map(call => call.url.slice(API.length))).toEqual([
      `/accounts/${ACCOUNT}/workers/dispatch/namespaces/llll-cloud/scripts/srv-${SERVER}?force=true`,
      `/accounts/${ACCOUNT}/d1/database/d1-uuid`,
      `/accounts/${ACCOUNT}/storage/kv/namespaces/kv-id`,
      `/accounts/${ACCOUNT}/r2/buckets/llll-srv-${SERVER}-files`,
    ])
    expect(calls.some(call => call.url.includes('-backups'))).toBe(false)
  })
})
