// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { computed, ref, type Ref } from 'vue'
import { useShell } from '../../apps/site/app/composables/useShell'
import { EMBED_VERSION } from '../../shared/embed'

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
function frameClaim(shell: ReturnType<typeof useShell>) {
  return new URL(shell.frameSrc(origin, location.origin)).hash
}

it('recovers the installer claim on a bookmarked setup reload', async () => {
  bookmark()
  const shell = useShell()
  shell.initialize()
  await shell.resolveServer()
  expect(Boolean(frameClaim(shell))).toBe(true)
  expect(installer).toHaveBeenCalledWith('/api/deploy/session')
  expect(localStorage.getItem('llll.shell.servers.v1')).not.toContain(claim)
})

it('takes an explicit setup claim before replacing the outer route', async () => {
  bookmark()
  route.hash = '#claim=' + claim
  route.fullPath += '?parent=' + encodeURIComponent(location.origin) + route.hash
  installer.mockRejectedValue(new Error('Expired installer'))
  const shell = useShell()
  shell.initialize()
  await shell.resolveServer()
  expect(frameClaim(shell)).toBe('#claim=' + claim)
  expect(installer).not.toHaveBeenCalled()
  expect(replace).not.toHaveBeenCalledWith(expect.stringContaining(claim))
  expect(localStorage.getItem('llll.shell.servers.v1')).not.toContain(claim)
})

it('can hand a claim to an already loaded unclaimed Server', async () => {
  installer.mockRejectedValue(new Error('No installer session'))
  const shell = useShell()
  shell.initialize()
  await shell.connect(origin)
  expect(frameClaim(shell)).toBe('')
  await shell.connect(origin, claim)
  expect(frameClaim(shell)).toBe('#claim=' + claim)
})

it('keeps the initial setup fragment intact and waits for readiness before navigation', async () => {
  bookmark()
  const shell = useShell()
  shell.initialize()
  const frame = document.createElement('iframe')
  document.body.append(frame)
  const child = frame.contentWindow!
  const post = vi.spyOn(child, 'postMessage').mockImplementation(() => {})
  shell.frames.value[origin] = frame
  await shell.resolveServer()
  expect(post).not.toHaveBeenCalled()
  listener(new MessageEvent('message', { origin, source: child, data: { llll: EMBED_VERSION, type: 'ready', version: EMBED_VERSION, name: 'Fixture' } }))
  expect(post).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'open' }), origin)
  shell.open(shell.servers.value[0]!, id, '/channels/general')
  expect(post).toHaveBeenCalledWith(expect.objectContaining({ type: 'open', serverId: id, path: '/channels/general' }), origin)
  frame.remove()
})

it('never recovers a different Server’s installer claim', async () => {
  bookmark()
  installer.mockResolvedValue({ completed: true, origin: 'https://other.example', claim: 'https://other.example/setup#claim=' + claim })
  const shell = useShell()
  shell.initialize()
  await shell.resolveServer()
  expect(frameClaim(shell)).toBe('')
})

it('reloads an already open Client at setup when the claim arrives later', async () => {
  installer.mockRejectedValue(new Error('No installer session'))
  const shell = useShell()
  shell.initialize()
  await shell.connect(origin)
  bookmark()
  route.hash = '#claim=' + claim
  route.fullPath += route.hash
  await shell.resolveServer()
  const frame = new URL(shell.frameSrc(origin, location.origin))
  expect(frame.pathname).toBe('/setup')
  expect(frame.hash).toBe('#claim=' + claim)
})
