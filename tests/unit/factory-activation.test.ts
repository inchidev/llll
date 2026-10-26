import { expect, it, vi } from 'vitest'
import { mcpFixture, ids } from '../helpers/outbound-mcp'
import { CLOUDFLARE_SCOPES } from '../../shared/cloudflare-oauth'
import { errorMessage } from '../../app/composables/useApi'
import { factoryImageAccepted, factoryProbeRepositoryName, factoryRepositoryName } from '../../shared/software-factory'
import { configureCloudflareFactory, factorySetup } from '../../server/utils/factory-setup'

vi.mock('cloudflare:workers', () => ({
  WorkerEntrypoint: class { constructor(protected ctx: unknown, protected env: unknown) {} },
  DurableObject: class { constructor(protected ctx: unknown, protected env: unknown) {} },
}))

const { FactoryComputeDurableObject } = await import('../../workers/factory-compute')
const image = 'registry.cloudflare.com/account/factory@sha256:' + 'a'.repeat(64)
const policy = JSON.stringify({ diskBytes: 8000000000, cpu: 0.5, memoryMiB: 4096, processLimit: 128, timeoutMs: 120000 })

it('requests the Artifacts OAuth scopes Factory provisioning calls', () => {
  const scopes = CLOUDFLARE_SCOPES.split(' ')
  expect(scopes).toContain('artifacts.read')
  expect(scopes).toContain('artifacts.write')
  expect(new Set(scopes).size).toBe(scopes.length)
})

it('accepts an empty inspect image and a matching digest, and rejects a different one', () => {
  expect(factoryImageAccepted('', image)).toBe(true)
  expect(factoryImageAccepted(undefined, image)).toBe(true)
  expect(factoryImageAccepted('registry.example/other@sha256:' + 'a'.repeat(64), image)).toBe(true)
  expect(factoryImageAccepted('sha256:' + 'b'.repeat(64), image)).toBe(false)
  expect(factoryImageAccepted(image, 'not-a-digest')).toBe(false)
  const repository = factoryRepositoryName(ids.server, ids.owner)
  const probe = factoryProbeRepositoryName(ids.server, ids.member)
  expect(repository.length).toBeLessThanOrEqual(63)
  expect(probe.length).toBeLessThanOrEqual(63)
  expect(repository).toMatch(/^l4[a-f0-9]+$/)
  expect(probe).toMatch(/^l4probe[a-f0-9]+$/)
})

it('returns a readable message when the Server response is only an HTTP status line', () => {
  expect(errorMessage({ data: { error: { message: 'Artifacts namespace unavailable' } } })).toBe('Artifacts namespace unavailable')
  expect(errorMessage(Object.assign(new Error('[POST] "/api/factory": 500 Internal Server Error'), { data: { message: 'Internal Server Error' } }))).toBe('The request failed, and the Server did not return a message.')
  expect(errorMessage(new Error('Saved'))).toBe('Saved')
})

it('returns the container probe failure from activation and does not record a compute node', async () => {
  const fixture = mcpFixture()
  const create = vi.fn()
  Object.assign(fixture.env, {
    FACTORY_IMAGE: image, FACTORY_POLICY: policy,
    FACTORY_COMPUTE: { getByName: () => ({ fetch: async () => Response.json({ ready: false, message: 'Released container image mismatch' }, { status: 503 }) }) },
    FACTORY_CODE: { create, get: vi.fn(), delete: vi.fn(async () => {}) },
  })
  await expect(configureCloudflareFactory(fixture.env, await fixture.actor(), true)).rejects.toMatchObject({ statusCode: 503, data: { error: { message: expect.stringContaining('Released container image mismatch') } } })
  expect(create).not.toHaveBeenCalled()
  expect(fixture.db.prepare('SELECT count(*) AS count FROM compute_nodes').get()).toMatchObject({ count: 0 })
  fixture.db.close()
})

it('returns an Artifacts failure from activation and does not record a compute node', async () => {
  const fixture = mcpFixture()
  Object.assign(fixture.env, {
    FACTORY_IMAGE: image, FACTORY_POLICY: policy,
    FACTORY_COMPUTE: { getByName: () => ({ fetch: async () => Response.json({ ready: true }) }) },
    FACTORY_CODE: { create: vi.fn(async () => { throw new Error('namespace missing') }), get: vi.fn(), delete: vi.fn(async () => {}) },
  })
  await expect(configureCloudflareFactory(fixture.env, await fixture.actor(), true)).rejects.toMatchObject({ statusCode: 502, data: { error: { code: 'factory_artifacts', message: expect.stringContaining('namespace missing') } } })
  expect(fixture.db.prepare('SELECT count(*) AS count FROM compute_nodes').get()).toMatchObject({ count: 0 })
  fixture.db.close()
})

it('describes VPS Factory cost as host capacity', async () => {
  const fixture = mcpFixture()
  fixture.env.LLLL_RUNTIME = 'celld'
  const setup = await factorySetup(fixture.env, await fixture.actor())
  expect(setup.placement).toBe('vps')
  expect(setup.costs).toContain('host CPU, disk and network')
  expect(setup.costs).not.toContain('Cloudflare compute')
  fixture.db.close()
})

it('turns a container start failure into a probe response instead of an uncaught Worker error', async () => {
  const fixture = mcpFixture()
  const running = { value: false }
  const container = {
    get running() { return running.value },
    start: vi.fn(async () => { throw new Error('no container image configured') }),
    destroy: vi.fn(async () => { running.value = false }),
    setInactivityTimeout: vi.fn(async () => {}),
    inspect: vi.fn(async () => ({ image: '' })),
    exec: vi.fn(async () => ({ exitCode: Promise.resolve(0), stdout: null })),
  }
  Object.assign(fixture.env, { FACTORY_IMAGE: image, FACTORY_COMPUTE: { idFromName: (name: string) => name } })
  const instance = new FactoryComputeDurableObject({ id: { equals: (id: unknown) => id === `probe:${ids.server}` }, container } as never, fixture.env)
  const response = await instance.fetch(new Request('http://factory/probe', { method: 'POST' }))
  expect(response.status).toBe(503)
  expect(await response.json()).toMatchObject({ ready: false, message: 'no container image configured' })
  fixture.db.close()
})

it('accepts the approved image when inspect does not echo it', async () => {
  const fixture = mcpFixture()
  const running = { value: false }
  const container = {
    get running() { return running.value },
    start: vi.fn(async () => { running.value = true }),
    destroy: vi.fn(async () => { running.value = false }),
    setInactivityTimeout: vi.fn(async () => {}),
    inspect: vi.fn(async () => ({ image: '' })),
    exec: vi.fn(async () => ({ exitCode: Promise.resolve(0), stdout: null })),
  }
  Object.assign(fixture.env, { FACTORY_IMAGE: image, FACTORY_COMPUTE: { idFromName: (name: string) => name } })
  const instance = new FactoryComputeDurableObject({ id: { equals: (id: unknown) => id === `probe:${ids.server}` }, container } as never, fixture.env)
  const response = await instance.fetch(new Request('http://factory/probe', { method: 'POST' }))
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ ready: true })
  expect(container.destroy).toHaveBeenCalled()
  fixture.db.close()
})
