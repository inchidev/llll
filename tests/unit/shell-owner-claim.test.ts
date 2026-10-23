// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { computed, ref, type Ref } from 'vue'
import { useShell } from '../../apps/site/app/composables/useShell'
import { EMBED_VERSION } from '../../shared/embed'
import { recordDeployedServer, readDeployedServers } from '../../shared/deploy-recall'

const origin = 'https://fixture.customer.workers.dev'
const id = '20bce15e-c83c-4f92-b90d-cee8eab23ce5'
const claim = 'synthetic-owner-claim-'.padEnd(64, 'x')
let state = new Map<string, Ref<unknown>>()
const route: { params: Record<string, string>; fullPath: string; hash: string } = { params: {}, fullPath: '/create', hash: '' }
const replace = vi.fn()
const push = vi.fn()
const installer = vi.fn()
let listener: (event: MessageEvent) => void

beforeEach(() => {
  state = new Map()
  localStorage.clear()
  route.params = {}
  route.fullPath = '/create'
  route.hash = ''
  installer.mockReset().mockResolvedValue({ completed: true, origin, claim: origin + '/setup#claim=' + claim })
  replace.mockReset()
  push.mockReset()
  vi.stubGlobal('computed', computed)
  vi.stubGlobal('useState', (key: string, create: () => unknown) => {
    if (!state.has(key)) state.set(key, ref(create()))
    return state.get(key)
  })
  vi.stubGlobal('useRoute', () => route)
  vi.stubGlobal('useRouter', () => ({ replace, push }))
  vi.stubGlobal('$fetch', installer)
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
    product: 'llll', kind: 'server', apiVersion: 2, id, origin,
    name: 'Fixture', embedOrigins: [location.origin], ready: false,
  }))))
  vi.spyOn(window, 'addEventListener').mockImplementation((type, handler) => {
    if (type === 'message' && typeof handler === 'function') listener = handler
  })
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

function bookmark() {
  localStorage.setItem('llll.shell.servers.v1', JSON.stringify([{ id, origin, name: 'Fixture', unread: 0 }]))
  route.params = { serverId: id }
  route.fullPath = '/' + id + '/setup'
}
function setupClaim(shell: ReturnType<typeof useShell>) { return new URL(shell.ownerSetupUrl(origin)).hash }

it('recovers an installer claim for top-level setup without loading an iframe', async () => {
  bookmark(); const shell = useShell(); shell.initialize(); await shell.resolveServer()
  expect(setupClaim(shell)).toBe('#claim=' + claim)
  expect(new URL(shell.frameSrc(origin, location.origin)).hash).toBe('')
  expect(shell.loaded.value).toEqual([])
  expect(shell.unclaimed.value[origin]).toBe(true)
  expect(localStorage.getItem('llll.shell.servers.v1')).not.toContain(claim)
})
it('preserves an explicit claim when the installer session has expired', async () => {
  bookmark(); route.hash = '#claim=' + claim; route.fullPath += route.hash
  installer.mockRejectedValue(new Error('Expired'))
  const shell = useShell(); shell.initialize(); await shell.resolveServer()
  expect(setupClaim(shell)).toBe('#claim=' + claim)
  expect(new URL(shell.frameSrc(origin, location.origin)).hash).toBe('')
  expect(installer).not.toHaveBeenCalled()
})
it('does not recover another Server’s claim', async () => {
  bookmark(); installer.mockResolvedValue({ completed: true, origin: 'https://other.example', claim: 'https://other.example/setup#claim=' + claim })
  const shell = useShell(); shell.initialize(); await shell.resolveServer()
  expect(setupClaim(shell)).toBe('')
})
it('keeps an earlier deployment’s top-level claim during a later deployment', async () => {
  bookmark(); installer.mockResolvedValue({ completed: false, deployments: [{ origin, claim: origin + '/setup#claim=' + claim }] })
  const shell = useShell(); shell.initialize(); await shell.resolveServer()
  expect(setupClaim(shell)).toBe('#claim=' + claim)
})
it('loads the Client only after discovery confirms the owner has claimed the Server', async () => {
  const shell = useShell(); shell.initialize(); await shell.connect(origin, claim)
  expect(shell.loaded.value).toEqual([])
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ product: 'llll', kind: 'server', apiVersion: 2, id, origin, name: 'Fixture', ready: true })))
  await shell.readMetadata(origin)
  expect(shell.unclaimed.value[origin]).toBe(false)
  expect(shell.loaded.value).toEqual([origin])
  expect(setupClaim(shell)).toBe('')
  expect(new URL(shell.frameSrc(origin, location.origin)).pathname).toBe('/')
})

it('refreshes a saved connection and deployment recall from public metadata without opening a Client', async () => {
  bookmark()
  recordDeployedServer({ origin, name: 'Old deploy name', completedAt: 1 })
  const shell = useShell()
  shell.initialize()
  const iconUrl = origin + '/.well-known/llll/icon?v=2'
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ product: 'llll', kind: 'server', apiVersion: 2, id, origin, name: 'Renamed community', iconUrl, updatedAt: '2026-10-20T02:00:00.000Z', ready: true })))
  await shell.refreshMetadata()
  expect(shell.servers.value[0]).toMatchObject({ name: 'Renamed community', iconUrl })
  expect(shell.groups.value[0]?.servers[0]?.iconUrl).toBe(iconUrl)
  expect(readDeployedServers()[0]).toMatchObject({ id, name: 'Renamed community', iconUrl })
  expect(shell.loaded.value).toEqual([])
  expect(localStorage.getItem('llll.shell.servers.v1')).not.toContain('claim')
})

it('applies live name/icon changes and deletion while rejecting stale metadata and another UUID', () => {
  bookmark()
  const shell = useShell()
  shell.initialize()
  const frame = document.createElement('iframe'); document.body.append(frame)
  shell.frames.value[origin] = frame
  const emit = (name: string, iconUrl: string | null, updatedAt: string) => listener(new MessageEvent('message', { origin, source: frame.contentWindow!, data: { llll: EMBED_VERSION, type: 'servers', servers: [{ id, name, iconUrl, updatedAt, unread: 2 }] } }))
  emit('New name', origin + '/.well-known/llll/icon?v=2', '2026-10-20T02:00:00.000Z')
  emit('Stale name', null, '2026-10-20T01:00:00.000Z')
  expect(shell.servers.value[0]?.name).toBe('New name')
  expect(shell.servers.value[0]?.iconUrl).toContain('v=2')
  emit('Newest name', null, '2026-10-20T03:00:00.000Z')
  expect(shell.servers.value[0]).toMatchObject({ name: 'Newest name', iconUrl: null })
  expect(shell.updateMetadata(origin, { id: crypto.randomUUID(), name: 'Replacement Server' })).toBe(false)
  expect(shell.servers.value[0]?.id).toBe(id)
  expect(shell.servers.value[0]?.name).toBe('Newest name')
  frame.remove()
})

it('refreshes the name on reconnect instead of keeping the first discovery response forever', async () => {
  bookmark()
  const shell = useShell(); shell.initialize()
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ product: 'llll', kind: 'server', apiVersion: 2, id, origin, name: 'Renamed on Server', embedOrigins: [location.origin], ready: true })))
  await shell.connect(origin)
  expect(shell.servers.value[0]?.name).toBe('Renamed on Server')
})

it('adds an alias without creating a second Server entry for the same UUID', async () => {
  bookmark()
  const alias = 'https://alias.example.com'
  const shell = useShell(); shell.initialize()
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ product: 'llll', kind: 'server', apiVersion: 2, id, origin, aliases: [alias], name: 'Fixture', embedOrigins: [location.origin], ready: true })))
  await shell.connect(alias)
  expect(shell.servers.value.filter(server => server.id === id)).toHaveLength(1)
  expect(shell.servers.value[0]?.origin).toBe(origin)
})

it('preserves a direct Agents URL while the embedded Client is still starting', async () => {
  bookmark(); route.fullPath = '/' + id + '/agents'
  const shell = useShell(); shell.initialize()
  const frame = document.createElement('iframe'); document.body.append(frame)
  shell.frames.value[origin] = frame
  shell.selected.value = origin
  replace.mockClear()
  listener(new MessageEvent('message', { origin, source: frame.contentWindow!, data: { llll: EMBED_VERSION, type: 'navigate', serverId: id, path: '/channels/general' } }))
  expect(replace).not.toHaveBeenCalled()
  frame.remove()
})
