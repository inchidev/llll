import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mcpFixture, ids } from '../helpers/outbound-mcp'
import { ALL_PERMISSIONS, Permission } from '../../shared/permissions'
import { factoryHash } from '../../server/utils/factory-authority'
import { factoryToolCall, decideFactoryAction } from '../../server/utils/factory-actions'
import * as githubAgent from '../../server/utils/github-agent-client'
import { findAgentRun } from '../../server/utils/agent-run-service'
import { FactoryOutbound } from '../../workers/factory-outbound'
import { FactoryComputeDurableObject } from '../../workers/factory-compute'
import { factoryRepositoryName } from '../../shared/software-factory'
import type { AgentRun } from '../../shared/agent-execution'
import type { L4Env } from '../../workers/env'
import { configureCloudflareFactory } from '../../server/utils/factory-setup'
import { beginUnusedFactoryRepair } from '../../packages/deployment-core/src/factory-repair'
import { cloudCodeBridge } from '../../workers/factory-code-bridge'

vi.mock('cloudflare:workers', () => ({
  WorkerEntrypoint: class { constructor(protected ctx: unknown, protected env: unknown) {} },
  DurableObject: class { constructor(protected ctx: unknown, protected env: unknown) {} },
}))

const nodeId = '00000000-0000-4000-8000-000000000099'
const image = 'registry.cloudflare.com/account/factory@sha256:' + 'a'.repeat(64)
const capabilities = { provider: 'cloudflare-containers', diskBytes: 8000000000, docker: false, durableDisk: false, isolation: 'container-vm', image,
  maxParallel: 1, protocol: 1, memoryMiB: 4096, cpu: 0.5, processLimit: 128, codeBytes: 500000000, timeoutMs: 120000 }
const config = { name: 'Original upstream', computeNodeId: nodeId, sourceRepo: 'inchidev/afterprompt', sourceRepoId: 11, sourceInstallationId: 101,
  workRepo: 'inchidev/afterprompt', workRepoId: 11, workInstallationId: 101, baseBranch: 'main', requiredChecks: ['test'], previewHosts: [] }
const lease = 'b'.repeat(64), codeRemote = 'https://account.artifacts.cloudflare.net/git/server/task.git'
let f: ReturnType<typeof mcpFixture>, run: AgentRun, actionId: string, workspaceId: string
const network = vi.fn(async (_request: Request) => new Response('Provider Git response'))

beforeEach(async () => {
  f = mcpFixture()
  f.db.prepare('UPDATE roles SET permissions_bitmask=? WHERE id=?').run(ALL_PERMISSIONS, ids.agentRole)
  f.db.prepare('INSERT INTO task_boards(id,name,created_by) VALUES(?,?,?)').run('factory-board', 'Factory', ids.owner)
  f.db.prepare("INSERT INTO tasks(id,board_id,title,assignee_id,created_by,status) VALUES(?,?,?,?,?,'ready')").run('factory-task', 'factory-board', 'Repair the original repository', ids.agent, ids.owner)
  const created = await f.run(ids.owner, undefined, 'factory-task')
  f.db.prepare('INSERT INTO compute_nodes(id,name,token_hash,capabilities_json,last_seen,created_by,created_at) VALUES(?,?,?,?,?,?,?)')
    .run(nodeId, 'Cloudflare', await factoryHash('unexposed-node-token'), JSON.stringify(capabilities), new Date().toISOString(), ids.owner, new Date().toISOString())
  f.db.prepare('INSERT INTO agent_environments(id,config_json,created_by,created_at,updated_at) VALUES(?,?,?,?,?)')
    .run('factory-env', JSON.stringify(config), ids.owner, new Date().toISOString(), new Date().toISOString())
  f.db.prepare('UPDATE tasks SET environment_id=? WHERE id=?').run('factory-env', 'factory-task')
  f.db.prepare('UPDATE agent_runs SET environment_json=?,mandate_json=? WHERE id=?')
    .run(JSON.stringify({ ...config, id: 'factory-env', enabled: true, version: 1, baseSha: 'a'.repeat(40), baseTreeSha: 'b'.repeat(40) }),
      JSON.stringify({ ...JSON.parse(created.run.mandateJson), environmentId: 'factory-env', environmentVersion: 1 }), created.run.id)
  run = (await findAgentRun(f.env, created.run.id))!
  const initial = await factoryToolCall(f.env, run.id, 'bootstrap', { operation: 'bootstrap' })
  actionId = initial.actionId
  workspaceId = (f.db.prepare('SELECT workspace_id AS id FROM factory_actions WHERE id=?').get(actionId) as { id: string }).id
  f.db.prepare("UPDATE factory_actions SET status='executing',lease_token=?,lease_until=? WHERE id=?")
    .run(lease, new Date(Date.now() + 60000).toISOString(), actionId)
  // workerd accepts streamed request bodies directly; Node's Undici needs its duplex hint.
  const NativeRequest = globalThis.Request
  vi.stubGlobal('Request', class extends NativeRequest {
    constructor(input: ConstructorParameters<typeof NativeRequest>[0], init?: RequestInit) { super(input, { ...init, duplex: 'half' } as RequestInit) }
  })
  network.mockClear(); vi.stubGlobal('fetch', network)
})
afterEach(() => { f.db.close(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

function outbound(phase: 'source' | 'restore' | 'checkpoint' | 'command', remote = codeRemote, token = 'private-working-repo-capability') {
  return new FactoryOutbound({ props: { actionId, lease, phase, remote, token } } as never, f.env)
}
const request = (url: string, method = 'GET') => new Request(url, { method, headers: { Authorization: 'Bearer attacker-selected', Cookie: 'private-cookie', 'X-Test': 'safe-header' }, ...(method === 'POST' ? { body: 'bounded Git body' } : {}) })

it('keeps source credentials in the trusted outbound Worker and scopes them to original-repository Git reads', async () => {
  const source = 'https://github.com/inchidev/afterprompt.git'
  const worker = outbound('source', source, 'single-repository-read-token')
  expect((await worker.fetch(request(source + '/info/refs?service=git-upload-pack'))).status).toBe(200)
  const forwarded = network.mock.calls[0]![0]
  expect(forwarded.headers.get('Authorization')).toBe('Basic ' + btoa('x-access-token:single-repository-read-token'))
  expect(forwarded.headers.has('cookie')).toBe(false)
  expect(forwarded.redirect).toBe('manual')
  for (const url of [source + '/git-receive-pack', 'https://github.com/other/private.git/info/refs?service=git-upload-pack', 'https://attacker.example/info/refs?service=git-upload-pack']) {
    expect((await worker.fetch(request(url, 'POST'))).status).toBe(403)
  }
  expect(network).toHaveBeenCalledTimes(1)
})

it.each(['restore', 'checkpoint'] as const)('scopes %s capabilities to one private Task code repository and the selected Git service', async phase => {
  const worker = outbound(phase), service = phase === 'checkpoint' ? 'git-receive-pack' : 'git-upload-pack'
  expect((await worker.fetch(request(codeRemote + '/info/refs?service=' + service))).status).toBe(200)
  expect((await worker.fetch(request(codeRemote + '/' + service, 'POST'))).status).toBe(200)
  expect(network.mock.calls[0]![0].headers.get('Authorization')).toBe('Bearer private-working-repo-capability')
  const otherService = phase === 'checkpoint' ? 'git-upload-pack' : 'git-receive-pack'
  for (const url of [codeRemote.replace('/task.git', '/another-task.git') + '/info/refs?service=' + service,
    codeRemote + '/info/refs?service=' + otherService, codeRemote + '/' + otherService,
    codeRemote.replace('https:', 'http:'), codeRemote.replace('.net', '.net:8443')]) {
    expect((await worker.fetch(request(url))).status).toBe(403)
  }
  expect(network).toHaveBeenCalledTimes(2)
})

it('rejects redirect responses without forwarding credentials to another destination', async () => {
  network.mockResolvedValueOnce(new Response(null, { status: 307, headers: { Location: 'https://attacker.example/steal' } }))
  const result = await outbound('restore').fetch(request(codeRemote + '/info/refs?service=git-upload-pack'))
  expect(result.status).toBe(502)
  expect(await result.text()).not.toContain('private-working-repo-capability')
  expect(network).toHaveBeenCalledTimes(1)
})

it.each(['expired lease', 'settled action', 'disabled node', 'removed computer grant', 'changed workspace initiator'])('rechecks %s before a storage request can use its capability', async change => {
  if (change === 'expired lease') f.db.prepare("UPDATE factory_actions SET lease_until='2000-01-01' WHERE id=?").run(actionId)
  if (change === 'settled action') f.db.prepare("UPDATE factory_actions SET status='completed' WHERE id=?").run(actionId)
  if (change === 'disabled node') f.db.prepare('UPDATE compute_nodes SET enabled=0 WHERE id=?').run(nodeId)
  if (change === 'removed computer grant') f.db.prepare('UPDATE roles SET permissions_bitmask=? WHERE id=?').run(ALL_PERMISSIONS & ~Permission.useComputer, ids.agentRole)
  if (change === 'changed workspace initiator') f.db.prepare('UPDATE factory_workspaces SET initiated_by=? WHERE id=?').run(ids.member, workspaceId)
  expect((await outbound('restore').fetch(request(codeRemote + '/info/refs?service=git-upload-pack'))).status).toBe(403)
  expect(network).not.toHaveBeenCalled()
})

it('permits only reviewed command HTTPS hosts and never attaches source or code-store credentials', async () => {
  f.db.prepare("UPDATE factory_actions SET request_json=? WHERE id=?").run(JSON.stringify({ operation: 'exec', command: 'npm test', timeoutMs: 30000, networkHosts: ['registry.npmjs.org'] }), actionId)
  const worker = outbound('command')
  expect((await worker.fetch(request('https://registry.npmjs.org/package'))).status).toBe(200)
  const forwarded = network.mock.calls[0]![0]
  expect(forwarded.headers.has('authorization')).toBe(false)
  expect(forwarded.headers.has('cookie')).toBe(false)
  expect((await worker.fetch(request('https://attacker.example/source'))).status).toBe(403)
  expect((await worker.fetch(request('http://registry.npmjs.org/package'))).status).toBe(403)
  expect(network).toHaveBeenCalledTimes(1)
})

function executor(seed: Record<string, unknown>, matches = true) {
  const values = new Map(Object.entries(seed)), destroy = vi.fn(async () => {}), exec = vi.fn()
  const ctx = { id: { equals: () => matches }, container: { running: true, destroy, exec }, storage: {
    get: async (key: string) => values.get(key),
    put: async (key: string | Record<string, unknown>, value?: unknown) => { if (typeof key === 'string') values.set(key, value); else Object.entries(key).forEach(([name, entry]) => values.set(name, entry)) },
    delete: async (keys: string | string[]) => { for (const key of Array.isArray(keys) ? keys : [keys]) values.delete(key) },
    transaction: async (operation: (transaction: { get: (key: string) => Promise<unknown>; delete: (key: string) => Promise<boolean> }) => Promise<unknown>) => operation({ get: async key => values.get(key), delete: async key => values.delete(key) }),
    setAlarm: vi.fn(async () => {}),
  } }
  f.env.FACTORY_COMPUTE = { idFromName: () => ({}) } as unknown as L4Env['FACTORY_COMPUTE']
  return { instance: new FactoryComputeDurableObject(ctx as never, f.env), ctx, values, destroy, exec }
}

it('rejects cross-workspace dispatch before it can queue or start a container', async () => {
  const fixture = executor({}, false)
  expect((await fixture.instance.fetch(new Request('http://factory/' + actionId, { method: 'POST' }))).status).toBe(403)
  expect(fixture.values.size).toBe(0)
  expect(fixture.exec).not.toHaveBeenCalled()
})

it('a restarted executor stops uncertain work and never starts the previous command again', async () => {
  const fixture = executor({ action: actionId, nodeId, started: true })
  await fixture.instance.alarm()
  expect(fixture.destroy).toHaveBeenCalledOnce()
  expect(fixture.exec).not.toHaveBeenCalled()
  expect(f.db.prepare('SELECT status FROM factory_actions WHERE id=?').get(actionId)).toMatchObject({ status: 'uncertain' })
  expect(fixture.values.has('action')).toBe(false)
  await fixture.instance.alarm()
  expect(fixture.destroy).toHaveBeenCalledTimes(1)
})

it('re-delivers a durably saved receipt exactly once without replaying container execution', async () => {
  const receipt = { operation: 'result', id: actionId, lease, result: { ok: true, exitCode: 0, output: 'Pinned and checkpointed code', runtimeMs: 100 } }
  const fixture = executor({ action: actionId, nodeId, started: true, receipt })
  await fixture.instance.alarm()
  expect(fixture.exec).not.toHaveBeenCalled()
  expect(f.db.prepare('SELECT status,result_json FROM factory_actions WHERE id=?').get(actionId)).toMatchObject({ status: 'completed', result_json: JSON.stringify(receipt.result) })
  expect(f.db.prepare('SELECT commands,status FROM factory_workspaces WHERE id=?').get(workspaceId)).toMatchObject({ commands: 1, status: 'ready' })
  expect(fixture.values.has('receipt')).toBe(false)
  await fixture.instance.alarm()
  expect(f.db.prepare('SELECT commands FROM factory_workspaces WHERE id=?').get(workspaceId)).toMatchObject({ commands: 1 })
})

async function provisioningFixture() {
  const { createHash } = await import('node:crypto')
  const sha = (value: string) => createHash('sha256').update(value).digest('hex')
  const accountId = 'a'.repeat(32), workerName = 'llll-' + ids.server
  const base = 'https://github.com/inchidev/llll/releases/download/v0.2.13/'
  const config = '{"architecture":"amd64","os":"linux"}', layer = 'verified immutable layer'
  const manifest = JSON.stringify({ schemaVersion: 2, config: { digest: 'sha256:' + sha(config) }, layers: [{ digest: 'sha256:' + sha(layer) }] })
  const files = Object.fromEntries([['llll-workspace-config.json', config], ['llll-workspace-layer-0.tar.gz', layer], ['llll-workspace-manifest.json', manifest]].map(([name, content]) => [name, { sha256: sha(content), size: Buffer.byteLength(content) }]))
  const factory = JSON.stringify({ schemaVersion: 1, version: '0.2.13', manifestDigest: 'sha256:' + sha(manifest), files,
    layers: [{ file: 'llll-workspace-layer-0.tar.gz', digest: 'sha256:' + sha(layer), size: Buffer.byteLength(layer) }] })
  const assets: Record<string, string> = { 'llll-factory.json': factory, 'llll-workspace-config.json': config, 'llll-workspace-layer-0.tar.gz': layer, 'llll-workspace-manifest.json': manifest }
  const expectedImage = `registry.cloudflare.com/${accountId}/${workerName}-factory@sha256:${sha(manifest)}`
  const state = { tamper: '', redirectUpload: false, uploaded: false, expandedSize: false, observability: undefined as undefined | { enabled: boolean }, application: null as null | Record<string, unknown>, existingImage: '', repairSupported: true, paidUnavailable: false, artifactsDenied: false, artifactsMissing: false }
  const calls: Array<{ path: string; init?: RequestInit }> = [], requests: Array<{ url: string; init?: RequestInit }> = []
  const api = vi.fn(async (_token: string, path: string, init?: RequestInit) => {
    calls.push({ path, init })
    if (path.endsWith('/containers/me')) { if (state.paidUnavailable) throw new Error('Workers Paid or Containers access required'); return {} }
    if (path.includes('/artifacts/namespaces')) {
      if (state.artifactsDenied) throw Object.assign(new Error('forbidden'), { statusCode: 403 })
      if (init?.method === 'POST') return { namespace: workerName + '-factory' }
      if (state.artifactsMissing) { state.artifactsMissing = false; throw Object.assign(new Error('missing'), { statusCode: 404 }) }
      return { name: workerName + '-factory' }
    }
    if (path.endsWith('/registries/registry.cloudflare.com/credentials')) return { username: 'v1', password: 'registry-secret' }
    if (path.includes('/d1/database/')) {
      const body = JSON.parse(String(init?.body))
      return [{ success: true, results: f.db.prepare(body.sql).all(...(body.params || [])) }]
    }
    if (path.endsWith('/containers/applications/existing/rollouts') && init?.method === 'POST') {
      const body = JSON.parse(String(init.body))
      expect(body).toMatchObject({ strategy: 'rolling', kind: 'full_auto', step_percentage: 100 })
      fixtureApplication().configuration = state.expandedSize
        ? { image: body.target_configuration.image, vcpu: 0.5, memory_mib: 4096, disk: { size_mb: 8000 } }
        : body.target_configuration
      return state.application
    }
    if (path.endsWith('/containers/applications/existing')) return state.application
    if (path.includes('/workers/scripts/')) { state.uploaded = true; return {} }
    if (path.endsWith('/containers/applications')) return init?.method === 'POST' ? { id: 'application-id' } : state.application ? [state.application] : []
    throw new Error('Unexpected control-plane path ' + path)
  })
  const settings = vi.fn(async () => ({
    observability: state.observability,
    bindings: [
      { type: 'd1', name: 'DB', database_id: 'existing-database' }, { type: 'secret_text', name: 'AUTH_SECRET' },
      { type: 'kv_namespace', name: 'TICKETS', namespace_id: 'existing-kv' }, { type: 'secret_text', name: 'GITHUB_AGENT_APP_PRIVATE_KEY' },
      ...(state.existingImage ? [{ type: 'plain_text', name: 'FACTORY_IMAGE', text: state.existingImage }] : []),
      ...(state.uploaded || state.existingImage ? [{ type: 'durable_object_namespace', name: 'FACTORY_COMPUTE', namespace_id: 'factory-namespace' }] : []),
    ], tags: ['llll-server'], annotations: { 'workers/tag': 'llll-0.2.13' }, containers: [{ class_name: 'AgentComputeDurableObject' }],
  }))
  vi.resetModules()
  vi.doMock('../../packages/deployment-core/src/cloudflare-client', () => ({ cloudflareApi: api, cloudflareClient: () => ({ workers: { scripts: { scriptAndVersionSettings: { get: settings } } } }) }))
  vi.doMock('../../packages/deployment-core/src/servers', () => ({ readL4Server: vi.fn(async () => ({ version: '0.2.13', origin: 'https://customer.example' })) }))
  vi.doMock('../../packages/deployment-core/src/release', () => ({ releaseManifestUrl: () => base + 'llll-cloudflare-manifest.json', loadL4Release: async () => ({ manifest: { version: '0.2.13', capabilities: state.repairSupported ? ['factory-unused-repair-v1'] : [], compatibilityDate: '2026-10-26', compatibilityFlags: ['nodejs_compat'], factory: { url: base + 'llll-factory.json', sha256: sha(factory), size: Buffer.byteLength(factory) } }, worker: new TextEncoder().encode('published immutable module').buffer }) }))
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input); requests.push({ url, init })
    if (url.startsWith(base)) {
      const name = url.slice(base.length), body = assets[name]
      if (body === undefined) throw new Error('Unexpected release asset ' + name)
      return new Response(name === state.tamper ? body.replace(/./u, 'X') : body)
    }
    if (url.startsWith('https://registry.cloudflare.com/')) {
      if (init?.body instanceof ReadableStream) await new Response(init.body).arrayBuffer()
      if (init?.method === 'POST') return new Response(null, { status: 202, headers: { Location: state.redirectUpload ? 'https://attacker.example/upload' : `/v2/${accountId}/${workerName}-factory/blobs/uploads/upload-${requests.length}` } })
      if (init?.method === 'PATCH') return new Response(null, { status: 202, headers: { Location: url } })
      return new Response(null, { status: 201 })
    }
    throw new Error('Unexpected remote destination ' + url)
  }))
  const module = await import('../../packages/deployment-core/src/factory')
  function fixtureApplication() { if (!state.application) throw new Error('Missing fixture application'); return state.application }
  return { enable: (consent = true) => module.enableL4Factory('browser-cloudflare-grant', accountId, workerName, consent), state, calls, requests, expectedImage }
}

it.each([undefined, { enabled: false }])('preserves Factory provisioning observability settings: %j', async observability => {
  const fixture = await provisioningFixture()
  fixture.state.observability = observability
  await fixture.enable()
  const uploaded = fixture.calls.find(call => call.path.includes('/workers/scripts/'))!
  const metadata = JSON.parse(String((uploaded.init!.body as FormData).get('metadata')))
  expect(metadata.observability).toMatchObject(observability ?? { enabled: true, redact_query_string: true })
})

it('repairs an old image only when Factory has never admitted a Node or Task source', async () => {
  const fixture = await provisioningFixture()
  f.db.exec('DELETE FROM factory_actions; DELETE FROM factory_workspaces; DELETE FROM compute_nodes')
  fixture.state.existingImage = 'registry.cloudflare.com/account/old@sha256:' + 'f'.repeat(64)
  fixture.state.application = { id: 'existing', name: 'llll-' + ids.server + '-factory', durable_objects: { namespace_id: 'factory-namespace' }, configuration: { image: fixture.state.existingImage, instance_type: 'standard-1' }, scheduling_policy: 'default' }
  await expect(fixture.enable()).resolves.toMatchObject({ image: fixture.expectedImage })
  expect(fixture.state.application.configuration).toMatchObject({ image: fixture.expectedImage })
  expect(f.db.prepare("SELECT value FROM server_settings WHERE key='factory.provisioning'").get()).toBeUndefined()
})

it('completes an image rollout when the provider expands the reviewed instance size', async () => {
  const fixture = await provisioningFixture()
  f.db.exec('DELETE FROM factory_actions; DELETE FROM factory_workspaces; DELETE FROM compute_nodes')
  fixture.state.expandedSize = true
  fixture.state.existingImage = 'old-image'
  fixture.state.application = { id: 'existing', name: 'llll-' + ids.server + '-factory', durable_objects: { namespace_id: 'factory-namespace' }, configuration: { image: 'old-image', vcpu: 0.5, memory_mib: 4096, disk: { size_mb: 8000 } }, scheduling_policy: 'default' }
  await expect(fixture.enable()).resolves.toMatchObject({ image: fixture.expectedImage })
  expect(f.db.prepare("SELECT value FROM server_settings WHERE key='factory.provisioning'").get()).toBeUndefined()
})

it('does not acquire repair authority for an unchanged expanded provider configuration', async () => {
  const fixture = await provisioningFixture()
  fixture.state.existingImage = fixture.expectedImage
  fixture.state.application = { id: 'existing', name: 'llll-' + ids.server + '-factory', durable_objects: { namespace_id: 'factory-namespace' }, configuration: { image: fixture.expectedImage, vcpu: 0.5, memory_mib: 4096, disk: { size_mb: 8000 } }, scheduling_policy: 'default' }
  // Existing Node and source authority deliberately remain: only an actual change needs repair.
  await expect(fixture.enable()).resolves.toMatchObject({ image: fixture.expectedImage })
  expect(fixture.calls.some(call => call.path.endsWith('/rollouts'))).toBe(false)
})

it.each(['node', 'source'])('preserves the pinned image when existing Factory %s authority remains', async kind => {
  const fixture = await provisioningFixture()
  fixture.state.existingImage = 'registry.cloudflare.com/account/old@sha256:' + 'f'.repeat(64)
  if (kind === 'node') f.db.exec('DELETE FROM factory_actions; DELETE FROM factory_workspaces')
  if (kind === 'source') f.db.exec("UPDATE compute_nodes SET capabilities_json=json_remove(capabilities_json,'$.provider')")
  await expect(fixture.enable()).rejects.toMatchObject({ statusCode: 409 })
  expect(fixture.state.uploaded).toBe(false)
  expect(fixture.calls.some(call => call.path.endsWith('/registries/registry.cloudflare.com/credentials'))).toBe(false)
})

function unusedFactory() { f.db.exec('DELETE FROM factory_actions; DELETE FROM factory_workspaces; DELETE FROM compute_nodes') }
const repairQuery = async (sql: string, params: (string | number)[]) => f.db.prepare(sql).all(...params) as { value: string }[]

it('serializes unused repair and fences a superseded installer', async () => {
  unusedFactory()
  const first = await beginUnusedFactoryRepair(repairQuery)
  await expect(beginUnusedFactoryRepair(repairQuery)).rejects.toMatchObject({ statusCode: 409 })
  f.db.prepare("UPDATE server_settings SET value=json_set(value,'$.expiresAt',0) WHERE key='factory.provisioning'").run()
  const next = await beginUnusedFactoryRepair(repairQuery)
  await expect(first.check()).rejects.toMatchObject({ statusCode: 409 })
  await expect(first.complete()).rejects.toMatchObject({ statusCode: 409 })
  await next.complete()
})

it('keeps failed provisioning closed to activation and allows a verified retry', async () => {
  const fixture = await provisioningFixture()
  unusedFactory(); fixture.state.existingImage = 'registry.cloudflare.com/account/old@sha256:' + 'f'.repeat(64)
  fixture.state.tamper = 'llll-workspace-layer-0.tar.gz'
  await expect(fixture.enable()).rejects.toThrow('Image layer checksum mismatch')
  expect(JSON.parse(String(f.db.prepare("SELECT value FROM server_settings WHERE key='factory.provisioning'").get()!.value)).failed).toBe(1)
  fixture.state.tamper = ''
  await fixture.enable()
  expect(f.db.prepare("SELECT value FROM server_settings WHERE key='factory.provisioning'").get()).toBeUndefined()
})

it('finishes a failed repair even when bindings and application already have the new image', async () => {
  const fixture = await provisioningFixture()
  unusedFactory(); fixture.state.existingImage = fixture.expectedImage
  fixture.state.application = { id: 'existing', name: 'llll-' + ids.server + '-factory', durable_objects: { namespace_id: 'factory-namespace' }, configuration: { image: fixture.expectedImage, instance_type: 'standard-1' }, scheduling_policy: 'default' }
  await (await beginUnusedFactoryRepair(repairQuery)).failed()
  await fixture.enable()
  expect(f.db.prepare("SELECT value FROM server_settings WHERE key='factory.provisioning'").get()).toBeUndefined()
})

it('requires the installed immutable Server artifact to advertise repair activation fencing', async () => {
  const fixture = await provisioningFixture()
  unusedFactory(); fixture.state.existingImage = 'old-image'; fixture.state.repairSupported = false
  await expect(fixture.enable()).rejects.toThrow('Update this Server')
  expect(fixture.state.uploaded).toBe(false)
  expect(f.db.prepare("SELECT value FROM server_settings WHERE key='factory.provisioning'").get()).toBeUndefined()
})

it.each(['before probe', 'during probe'])('blocks activation racing unused repair: %s', async phase => {
  unusedFactory()
  const probe = vi.fn(async () => {
    if (phase === 'during probe') await beginUnusedFactoryRepair(repairQuery)
    return Response.json({ ok: true })
  })
  f.env.FACTORY_IMAGE = image
  f.env.FACTORY_COMPUTE = { getByName: () => ({ fetch: probe }) } as never
  f.env.FACTORY_CODE = { create: async () => ({ token: 'probe-token' }), get: async () => ({ revokeToken: async () => {}, [Symbol.dispose]() {} }), delete: async () => {} } as never
  if (phase === 'before probe') await beginUnusedFactoryRepair(repairQuery)
  await expect(configureCloudflareFactory(f.env, await f.actor(), true)).rejects.toMatchObject({ statusCode: 409 })
  expect(f.db.prepare('SELECT count(*) AS n FROM compute_nodes').get()!.n).toBe(0)
  if (phase === 'before probe') expect(probe).not.toHaveBeenCalled()
})

it('paid provisioning requires explicit consent and stops before writes when provider access is unavailable', async () => {
  const fixture = await provisioningFixture()
  await expect(fixture.enable(false)).rejects.toMatchObject({ statusCode: 400 })
  expect(fixture.calls).toEqual([]); expect(fixture.requests).toEqual([])
  fixture.state.paidUnavailable = true
  await expect(fixture.enable()).rejects.toThrow('Workers Paid or Containers access required')
  expect(fixture.calls.every(call => !call.init?.method || call.init.method === 'GET')).toBe(true)
  expect(fixture.requests).toEqual([])
})

it('refuses Factory provisioning when the Cloudflare grant is missing Artifacts scopes', async () => {
  const fixture = await provisioningFixture()
  fixture.state.artifactsDenied = true
  await expect(fixture.enable()).rejects.toThrow('Reconnect Cloudflare and approve Artifacts Read and Artifacts Write')
  expect(fixture.calls.some(call => call.path.includes('/workers/scripts/'))).toBe(false)
  expect(fixture.calls.some(call => call.init?.method === 'POST')).toBe(false)
  expect(fixture.requests).toEqual([])
})

it('creates the Artifacts namespace when the account does not have one yet', async () => {
  const fixture = await provisioningFixture()
  fixture.state.artifactsMissing = true
  await fixture.enable()
  expect(fixture.calls.some(call => call.path.endsWith('/artifacts/namespaces') && call.init?.method === 'POST')).toBe(true)
})

it('provisions only verified release blobs, preserves existing bindings and never stores the browser account credential', async () => {
  const fixture = await provisioningFixture()
  expect(await fixture.enable()).toMatchObject({ state: 'provisioning', image: fixture.expectedImage, origin: 'https://customer.example' })
  const uploaded = fixture.calls.find(call => call.path.includes('/workers/scripts/'))!
  const form = uploaded.init!.body as FormData
  const metadata = JSON.parse(String(form.get('metadata')))
  expect(metadata.keep_assets).toBe(true)
  for (const name of ['DB', 'AUTH_SECRET', 'TICKETS', 'GITHUB_AGENT_APP_PRIVATE_KEY']) expect(metadata.bindings).toContainEqual({ type: 'inherit', name })
  expect(metadata.bindings).toContainEqual(expect.objectContaining({ type: 'artifacts', name: 'FACTORY_CODE' }))
  expect(metadata.bindings).not.toContainEqual(expect.objectContaining({ type: 'r2_bucket' }))
  expect(metadata.containers).toContainEqual({ class_name: 'AgentComputeDurableObject' })
  expect(metadata.containers).toContainEqual(expect.objectContaining({ class_name: 'FactoryComputeDurableObject', image: fixture.expectedImage, instance_type: 'standard-1', max_instances: 1, name: 'llll-' + ids.server + '-factory' }))
  expect(await (form.get('llll-worker.mjs') as Blob).text()).toBe('published immutable module')
  expect(JSON.stringify(metadata)).not.toContain('browser-cloudflare-grant')
  expect(JSON.stringify(metadata)).not.toContain('registry-secret')
  const registry = fixture.requests.filter(request => request.url.startsWith('https://registry.cloudflare.com/'))
  expect(registry.length).toBeGreaterThan(0)
  expect(registry.every(request => new Headers(request.init?.headers).get('Authorization') === 'Basic ' + btoa('v1:registry-secret'))).toBe(true)
  expect(fixture.calls.some(call => /subscriptions|r2|upgrade/iu.test(call.path))).toBe(false)
})

it('does not commit a corrupt layer or change the Server when a release blob checksum fails', async () => {
  const fixture = await provisioningFixture(); fixture.state.tamper = 'llll-workspace-layer-0.tar.gz'
  await expect(fixture.enable()).rejects.toThrow('Image layer checksum mismatch')
  expect(fixture.calls.some(call => call.path.includes('/workers/scripts/'))).toBe(false)
  expect(fixture.requests.some(request => request.url.includes('/manifests/'))).toBe(false)
})

it('refuses an image registry upload redirect before it can disclose registry credentials', async () => {
  const fixture = await provisioningFixture(); fixture.state.redirectUpload = true
  await expect(fixture.enable()).rejects.toThrow('Unexpected image registry upload destination')
  expect(fixture.requests.some(request => new URL(request.url).origin === 'https://attacker.example')).toBe(false)
  expect(fixture.calls.some(call => call.path.includes('/workers/scripts/'))).toBe(false)
})

it('refuses an existing application whose image differs from the approved release and limits', async () => {
  const fixture = await provisioningFixture()
  fixture.state.application = { id: 'existing', name: 'llll-' + ids.server + '-factory', durable_objects: { namespace_id: 'factory-namespace' },
    configuration: { image: 'registry.cloudflare.com/account/unreviewed@sha256:' + 'f'.repeat(64), instance_type: 'standard-4' }, scheduling_policy: 'default' }
  await expect(fixture.enable()).rejects.toThrow(/image|policy|limit|configuration/iu)
})

async function cloudAlarmFixture() {
  // Restore the original pending action, then use the real exact-action decision and claim/begin broker.
  f.db.prepare("UPDATE factory_actions SET status='pending',lease_token=NULL,lease_until=NULL WHERE id=?").run(actionId)
  const saved = f.db.prepare('SELECT digest FROM factory_actions WHERE id=?').get(actionId) as { digest: string }
  await decideFactoryAction(f.env, run.id, ids.owner, { id: actionId, digest: saved.digest, decision: 'approve' })
  const grant = vi.spyOn(githubAgent, 'githubSourceGrant').mockResolvedValue('upstream-read-only-capability')
  const values = new Map<string, unknown>(), events: string[] = []
  const inputs: Array<{ script: string; input: Record<string, unknown>; user: string | undefined }> = []
  const phases: Array<{ phase: string; token?: string; remote?: string; actionId: string }> = []
  const state = { running: false, image, checkpointFails: false, checkpointCount: 0, stderrNoise: '', invalidOutput: false }
  const container = {
    get running() { return state.running },
    start: vi.fn(() => { state.running = true; events.push('start') }),
    destroy: vi.fn(async () => { state.running = false; events.push('destroy') }),
    setInactivityTimeout: vi.fn(async () => {}),
    inspect: vi.fn(async () => ({ image: state.image })),
    interceptOutboundHttps: vi.fn(async (_host: string, binding: { props: { phase: string; token?: string; remote?: string; actionId: string } }) => { phases.push(binding.props) }),
    exec: vi.fn(async (argv: string[], options: { stdin?: ReadableStream; user?: string; stdout?: string; stderr?: string } = {}) => {
      if (argv[0] === '/usr/bin/pkill') { expect(options.user).toBe('0:0'); events.push('kill-background'); return { exitCode: Promise.resolve(0), stdout: null } }
      if (argv.includes('--version')) return { exitCode: Promise.resolve(0), stdout: null }
      const script = argv.at(-1) === cloudCodeBridge ? '/opt/l4/cloud-io.mjs' : argv.at(-1)!, input = JSON.parse(await new Response(options.stdin).text()) as Record<string, unknown>
      inputs.push({ script, input, user: options.user })
      expect(options.user).toBe('1000:1000')
      expect(argv[0]).toBe('/usr/bin/prlimit')
      expect(options.stdout).toBe('pipe'); expect(options.stderr).toBe('pipe')
      let output: unknown
      if (script.endsWith('/cloud-io.mjs')) {
        if (input.operation === 'bootstrap') { expect(phases.at(-1)?.phase).toBe('source'); events.push('source-cloned'); output = { ok: true } }
        else if (input.operation === 'restore') { expect(phases.at(-1)?.phase).toBe('restore'); events.push('checkpoint-restored'); output = { ok: true } }
        else {
          expect(phases.at(-1)?.phase).toBe('checkpoint'); events.push('checkpoint-confirmed')
          state.checkpointCount++
          output = state.checkpointFails ? { ok: false } : { ok: true, checkpoint: (state.checkpointCount === 1 ? 'c' : 'd').repeat(40), head: 'a'.repeat(40), tree: 'e'.repeat(40) }
        }
      } else { expect(script).toBe('/opt/l4/operate.mjs'); expect(phases.at(-1)?.phase).toBe('command'); events.push('command-completed'); output = { ok: true, exitCode: 0, output: 'Approved tests passed' } }
      return { exitCode: Promise.resolve(0), stdout: new Response(state.invalidOutput ? 'not-json' : JSON.stringify(output)).body, stderr: new Response(state.stderrNoise).body }
    }),
  }
  const handles: Array<{ revokeToken: ReturnType<typeof vi.fn>; [Symbol.dispose]: ReturnType<typeof vi.fn> }> = []
  let tokenCounter = 0
  const artifacts = {
    create: vi.fn(async () => { events.push('task-repo-created'); return { token: 'initial-code-token' } }),
    get: vi.fn(async () => {
      const handle = { info: vi.fn(async () => ({ remote: codeRemote })), createToken: vi.fn(async (scope: string) => ({ id: 'token-' + ++tokenCounter, plaintext: `${scope}-Task-code-capability` })),
        revokeToken: vi.fn(async () => {}), [Symbol.dispose]: vi.fn() }
      handles.push(handle); return handle
    }),
    delete: vi.fn(async () => {}),
  }
  const storage = {
    get: async (key: string) => values.get(key),
    put: async (key: string | Record<string, unknown>, value?: unknown) => {
      if (typeof key === 'string') { values.set(key, value); if (key === 'receipt') events.push('receipt-persisted'); if (key === 'checkpoint') events.push('checkpoint-persisted') }
      else Object.entries(key).forEach(([name, entry]) => values.set(name, entry))
    },
    delete: async (keys: string | string[]) => { for (const key of Array.isArray(keys) ? keys : [keys]) values.delete(key) },
    transaction: async (operation: (transaction: { get: (key: string) => Promise<unknown>; delete: (key: string) => Promise<boolean> }) => Promise<unknown>) => operation({ get: async key => values.get(key), delete: async key => values.delete(key) }),
    setAlarm: vi.fn(async () => {}),
  }
  const ctx = { id: { equals: (id: unknown) => id === `workspace:${workspaceId}` }, storage, container,
    exports: { FactoryOutbound: (binding: { props: unknown }) => binding } }
  Object.assign(f.env, { FACTORY_IMAGE: image, FACTORY_CODE: artifacts,
    FACTORY_COMPUTE: { idFromName: (name: string) => name, getByName: () => ({ fetch: async () => new Response(null, { status: 202 }) }) } })
  const instance = new FactoryComputeDurableObject(ctx as never, f.env)
  const queue = async (id = actionId) => { expect((await instance.fetch(new Request('http://factory/' + id, { method: 'POST' }))).status).toBe(202) }
  return { instance, queue, values, events, inputs, phases, state, artifacts, handles, container, grant }
}

it('runs approved Cloud bootstrap through scoped claim, durable checkpoint/receipt and teardown, then restores the next operation', async () => {
  const fixture = await cloudAlarmFixture()
  await fixture.queue(); await fixture.instance.alarm()
  expect(f.db.prepare('SELECT status FROM factory_actions WHERE id=?').get(actionId)).toMatchObject({ status: 'completed' })
  expect(f.db.prepare('SELECT commands,status FROM factory_workspaces WHERE id=?').get(workspaceId)).toMatchObject({ commands: 1, status: 'ready' })
  expect(fixture.grant).toHaveBeenCalledTimes(1)
  expect(fixture.artifacts.create).toHaveBeenCalledWith(factoryRepositoryName(ids.server, workspaceId), expect.anything())
  expect(fixture.phases.map(phase => phase.phase)).toEqual(['source', 'command', 'checkpoint'])
  expect(fixture.phases[0]).toMatchObject({ token: 'upstream-read-only-capability', remote: 'https://github.com/inchidev/afterprompt.git' })
  expect(JSON.stringify(fixture.inputs)).not.toContain('capability')
  expect(fixture.values.get('checkpoint')).toMatchObject({ sha: 'c'.repeat(40), image })
  expect(fixture.events.indexOf('checkpoint-confirmed')).toBeLessThan(fixture.events.indexOf('checkpoint-persisted'))
  expect(fixture.events.indexOf('checkpoint-persisted')).toBeLessThan(fixture.events.indexOf('receipt-persisted'))
  expect(fixture.events.indexOf('receipt-persisted')).toBeLessThan(fixture.events.indexOf('destroy'))
  expect(fixture.values.has('receipt')).toBe(false)
  expect(fixture.container.destroy).toHaveBeenCalledTimes(1)
  expect(fixture.handles[0]!.revokeToken).toHaveBeenCalledWith('initial-code-token')
  expect(fixture.handles[0]![Symbol.dispose]).toHaveBeenCalledOnce()

  const next = await factoryToolCall(f.env, run.id, 'next-command', { operation: 'exec', command: 'npm test' })
  const row = f.db.prepare('SELECT digest FROM factory_actions WHERE id=?').get(next.actionId) as { digest: string }
  await decideFactoryAction(f.env, run.id, ids.owner, { id: next.actionId, digest: row.digest, decision: 'approve' })
  await fixture.queue(next.actionId); await fixture.instance.alarm()
  expect(f.db.prepare('SELECT status FROM factory_actions WHERE id=?').get(next.actionId)).toMatchObject({ status: 'completed' })
  expect(fixture.grant).toHaveBeenCalledTimes(1)
  expect(fixture.artifacts.create).toHaveBeenCalledTimes(1)
  expect(fixture.phases.slice(3).map(phase => phase.phase)).toEqual(['restore', 'command', 'checkpoint'])
  expect(fixture.inputs.find(input => input.input.operation === 'restore')?.input).toMatchObject({ checkpoint: 'c'.repeat(40), baseSha: 'a'.repeat(40) })
  expect(fixture.values.get('checkpoint')).toMatchObject({ sha: 'd'.repeat(40), image })
  expect(f.db.prepare('SELECT commands FROM factory_workspaces WHERE id=?').get(workspaceId)).toMatchObject({ commands: 2 })
  expect(fixture.container.destroy).toHaveBeenCalledTimes(2)
  expect(JSON.stringify(fixture.inputs)).not.toContain('capability')
})

it('keeps helper warnings separate from its JSON protocol', async () => {
  const fixture = await cloudAlarmFixture()
  fixture.state.stderrNoise = 'Runtime warning containing private-diagnostic-data'
  await fixture.queue(); await fixture.instance.alarm()
  const row = f.db.prepare('SELECT status,result_json FROM factory_actions WHERE id=?').get(actionId)!
  expect(row.status).toBe('completed')
  expect(String(row.result_json)).not.toContain('private-diagnostic-data')
})

it.each(['start', 'timeout setup', 'readiness', 'readiness exit'] as const)('records a failed receipt for %s before workspace effects, without permanently fencing the Task', async failure => {
  const fixture = await cloudAlarmFixture()
  const unavailable = () => { throw new Error('private-provider-diagnostic') }
  if (failure === 'start') fixture.container.start.mockImplementationOnce(unavailable)
  else if (failure === 'timeout setup') fixture.container.setInactivityTimeout.mockImplementationOnce(unavailable)
  else {
    vi.stubGlobal('scheduler', { wait: vi.fn(async () => {}) })
    const execute = fixture.container.exec.getMockImplementation()!
    fixture.container.exec.mockImplementation(async (argv, options) => {
      if (argv.includes('--version')) {
        if (failure === 'readiness exit') return { exitCode: Promise.resolve(1), stdout: null }
        unavailable()
      }
      return execute(argv, options)
    })
  }
  await fixture.queue(); await fixture.instance.alarm()
  const row = f.db.prepare('SELECT status,result_json FROM factory_actions WHERE id=?').get(actionId)!
  expect(row.status).toBe('failed')
  expect(JSON.parse(String(row.result_json))).toMatchObject({ ok: false, exitCode: -1 })
  expect(String(row.result_json)).toContain('before any workspace operation')
  expect(String(row.result_json)).not.toContain('private-provider-diagnostic')
  expect(fixture.inputs).toEqual([])
  expect(fixture.artifacts.create).not.toHaveBeenCalled()
  expect(f.db.prepare('SELECT commands,status FROM factory_workspaces WHERE id=?').get(workspaceId)).toMatchObject({ commands: 1, status: 'new' })
  expect(fixture.values.has('receipt')).toBe(false)
  expect(fixture.values.has('action')).toBe(false)
  await fixture.instance.alarm()
  expect(fixture.container.start).toHaveBeenCalledTimes(1)
  const retry = await factoryToolCall(f.env, run.id, 'separately-reviewed-bootstrap', { operation: 'bootstrap' })
  expect(retry).toMatchObject({ factoryPending: true, status: 'pending' })
  expect(retry.actionId).not.toBe(actionId)
})

it('retains the acknowledged checkpoint when the next container cannot start, and never replays that action', async () => {
  const fixture = await cloudAlarmFixture()
  await fixture.queue(); await fixture.instance.alarm()
  const checkpoint = fixture.values.get('checkpoint')
  const next = await factoryToolCall(f.env, run.id, 'read-after-checkpoint', { operation: 'read', path: 'fixture.txt' })
  const row = f.db.prepare('SELECT digest FROM factory_actions WHERE id=?').get(next.actionId) as { digest: string }
  await decideFactoryAction(f.env, run.id, ids.owner, { id: next.actionId, digest: row.digest, decision: 'approve' })
  fixture.container.start.mockImplementationOnce(() => { throw new Error('private-provider-diagnostic') })
  await fixture.queue(next.actionId); await fixture.instance.alarm()
  expect(f.db.prepare('SELECT status FROM factory_actions WHERE id=?').get(next.actionId)).toMatchObject({ status: 'failed' })
  expect(fixture.values.get('checkpoint')).toEqual(checkpoint)
  expect(f.db.prepare('SELECT commands,status FROM factory_workspaces WHERE id=?').get(workspaceId)).toMatchObject({ commands: 2, status: 'ready' })
  expect(fixture.inputs.filter(input => input.script.endsWith('/operate.mjs'))).toHaveLength(0)
  expect(await factoryToolCall(f.env, run.id, 'read-after-checkpoint', { operation: 'read', path: 'fixture.txt' })).toMatchObject({ ok: false })
  await fixture.instance.alarm()
  expect(fixture.container.start).toHaveBeenCalledTimes(2)
  const reviewed = await factoryToolCall(f.env, run.id, 'new-reviewed-read', { operation: 'read', path: 'fixture.txt' })
  expect(reviewed).toMatchObject({ factoryPending: true, status: 'pending' })
})

it('retries delivery of a durable startup-failure receipt without restarting the container', async () => {
  const fixture = await cloudAlarmFixture()
  fixture.container.start.mockImplementationOnce(() => { throw new Error('Unavailable') })
  const batch = f.env.DB.batch.bind(f.env.DB)
  let interrupt = true
  vi.spyOn(f.env.DB, 'batch').mockImplementation(async statements => {
    if (interrupt && fixture.values.has('receipt')) { interrupt = false; throw new Error('Receipt transport interrupted') }
    return batch(statements)
  })
  await fixture.queue(); await fixture.instance.alarm()
  expect(fixture.values.get('receipt')).toMatchObject({ operation: 'result', result: { ok: false } })
  expect(f.db.prepare('SELECT status FROM factory_actions WHERE id=?').get(actionId)).toMatchObject({ status: 'executing' })
  await fixture.instance.alarm()
  expect(f.db.prepare('SELECT status FROM factory_actions WHERE id=?').get(actionId)).toMatchObject({ status: 'failed' })
  expect(fixture.values.has('receipt')).toBe(false)
  expect(fixture.container.start).toHaveBeenCalledTimes(1)
  expect(fixture.inputs).toEqual([])
})

it('keeps an unsuccessful reset of a previous container uncertain', async () => {
  const fixture = await cloudAlarmFixture()
  fixture.state.running = true
  fixture.container.destroy.mockRejectedValueOnce(new Error('Private reset failure'))
  await fixture.queue(); await fixture.instance.alarm()
  const row = f.db.prepare('SELECT status,result_json FROM factory_actions WHERE id=?').get(actionId)!
  expect(row.status).toBe('uncertain')
  expect(JSON.parse(String(row.result_json))).toMatchObject({ failureStage: 'container_reset' })
  expect(fixture.container.start).not.toHaveBeenCalled()
  expect(fixture.inputs).toEqual([])
})

it('records a safe failure stage without leaking diagnostics or replaying malformed output', async () => {
  const fixture = await cloudAlarmFixture()
  fixture.state.invalidOutput = true
  fixture.state.stderrNoise = 'private-diagnostic-data'
  await fixture.queue(); await fixture.instance.alarm()
  const row = f.db.prepare('SELECT status,result_json FROM factory_actions WHERE id=?').get(actionId)!
  expect(row.status).toBe('uncertain')
  expect(JSON.parse(String(row.result_json))).toMatchObject({ failureStage: 'source_bootstrap', failureCode: 'helper_json', checkpoint: null })
  expect(String(row.result_json)).not.toContain('private-diagnostic-data')
  await fixture.instance.alarm()
  expect(fixture.inputs).toHaveLength(1)
})

it('does not clone or acknowledge code when the running Cloud image differs from the approved digest', async () => {
  const fixture = await cloudAlarmFixture(); fixture.state.image = 'registry.cloudflare.com/account/changed@sha256:' + 'f'.repeat(64)
  await fixture.queue(); await fixture.instance.alarm()
  expect(f.db.prepare('SELECT status FROM factory_actions WHERE id=?').get(actionId)).toMatchObject({ status: 'uncertain' })
  expect(f.db.prepare('SELECT commands,status FROM factory_workspaces WHERE id=?').get(workspaceId)).toMatchObject({ commands: 0, status: 'new' })
  expect(fixture.inputs).toEqual([])
  expect(fixture.artifacts.create).not.toHaveBeenCalled()
  expect(fixture.values.has('receipt')).toBe(false)
  expect(fixture.container.destroy).toHaveBeenCalledOnce()
})

it('keeps a failed checkpoint uncertain without acknowledging or replaying the completed command', async () => {
  const fixture = await cloudAlarmFixture()
  await fixture.queue(); await fixture.instance.alarm()
  fixture.state.checkpointFails = true
  const next = await factoryToolCall(f.env, run.id, 'fails-checkpoint', { operation: 'exec', command: 'npm test' })
  const row = f.db.prepare('SELECT digest FROM factory_actions WHERE id=?').get(next.actionId) as { digest: string }
  await decideFactoryAction(f.env, run.id, ids.owner, { id: next.actionId, digest: row.digest, decision: 'approve' })
  await fixture.queue(next.actionId); await fixture.instance.alarm()
  expect(f.db.prepare('SELECT status FROM factory_actions WHERE id=?').get(next.actionId)).toMatchObject({ status: 'uncertain' })
  expect(fixture.values.get('checkpoint')).toMatchObject({ sha: 'c'.repeat(40) })
  expect(f.db.prepare('SELECT commands FROM factory_workspaces WHERE id=?').get(workspaceId)).toMatchObject({ commands: 1 })
  expect(fixture.values.has('receipt')).toBe(false)
  expect(fixture.container.destroy).toHaveBeenCalledTimes(2)
  const commands = fixture.inputs.filter(input => input.script.endsWith('/operate.mjs')).length
  await fixture.instance.alarm()
  expect(fixture.inputs.filter(input => input.script.endsWith('/operate.mjs'))).toHaveLength(commands)
})

it.each(['expired', 'revoked'] as const)('clears %s queued work without losing acknowledged source or starting a container', async reason => {
  f.db.prepare("UPDATE factory_actions SET status='approved' WHERE id=?").run(actionId)
  if (reason === 'expired') f.db.prepare("UPDATE factory_actions SET expires_at='2000-01-01' WHERE id=?").run(actionId)
  else f.db.prepare('UPDATE compute_nodes SET enabled=0 WHERE id=?').run(nodeId)
  const checkpoint = { sha: 'a'.repeat(40), repository: 'retained-task-code', image }
  const fixture = executor({ action: actionId, checkpoint })
  await fixture.instance.alarm()
  expect(fixture.values.has('action')).toBe(false)
  expect(fixture.values.get('checkpoint')).toEqual(checkpoint)
  expect(fixture.exec).not.toHaveBeenCalled()
  expect(fixture.destroy).not.toHaveBeenCalled()
})
