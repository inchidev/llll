import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import { renderPublicServiceWorker } from '../../scripts/pwa-source.mjs'

const origin = 'https://client.example.com'
const assets = ['/app-shell', '/_nuxt/client.js', '/site.webmanifest']

function generatedWorker(shellPolicy: string | null = "default-src 'self'; frame-ancestors 'self'") {
  const handlers = new Map<string, (event: Record<string, unknown>) => void>()
  const stored = new Map<string, Response>()
  const cache = { put: async (path: string, response: Response) => { stored.set(path, response) }, match: async (path: string) => stored.get(path) }
  class BrowserRequest extends Request {
    constructor(path: string, options: RequestInit) { super(new URL(path, origin), options) }
  }
  const fetch = vi.fn(async (request: Request) => new Response(request.url, { headers: new URL(request.url).pathname === '/app-shell' && shellPolicy ? { 'Content-Security-Policy': shellPolicy } : {} }))
  const skipWaiting = vi.fn(() => new Promise<void>(() => {}))
  const source = renderPublicServiceWorker(readFileSync('pwa/service-worker.js', 'utf8'), 'integration', assets)
  vm.runInNewContext(source, {
    URL, Request: BrowserRequest, fetch,
    caches: { open: async () => cache, keys: async () => ['llll-public-integration'], delete: vi.fn() },
    self: { skipWaiting, location: { origin }, addEventListener: (name: string, handler: (event: Record<string, unknown>) => void) => handlers.set(name, handler) },
  })
  return { handlers, stored, fetch, skipWaiting }
}

describe('generated PWA server', () => {
  it('requests activation without making the message lifetime depend on activation finishing', () => {
    const worker = generatedWorker()
    const waitUntil = vi.fn()
    worker.handlers.get('message')!({ data: { type: 'ACTIVATE_UPDATE' }, waitUntil })
    expect(worker.skipWaiting).toHaveBeenCalledOnce()
    expect(waitUntil).not.toHaveBeenCalled()
  })

  it('executes the generated script and precaches the complete public shell', async () => {
    const worker = generatedWorker()
    const pending: Promise<unknown>[] = []
    worker.handlers.get('install')!({ waitUntil: (promise: Promise<unknown>) => pending.push(promise) })
    await Promise.all(pending)
    expect([...worker.stored.keys()]).toEqual(assets)
    expect(worker.fetch.mock.calls.map(([request]) => ({ path: new URL(request.url).pathname, credentials: request.credentials }))).toEqual(assets.map(path => ({ path, credentials: 'omit' })))
  })

  it('refuses to install a shell that was not served with the Worker policy', async () => {
    const worker = generatedWorker(null)
    const pending: Promise<unknown>[] = []
    worker.handlers.get('install')!({ waitUntil: (promise: Promise<unknown>) => pending.push(promise) })
    await expect(Promise.all(pending)).rejects.toThrow('Content-Security-Policy')
  })

  it('answers navigations with the protected shell, except the MCP consent page', async () => {
    const worker = generatedWorker()
    const pending: Promise<unknown>[] = []
    worker.handlers.get('install')!({ waitUntil: (promise: Promise<unknown>) => pending.push(promise) })
    await Promise.all(pending)
    const navigate = (path: string) => {
      const respondWith = vi.fn()
      const request = new Request(origin + path)
      Object.defineProperty(request, 'mode', { value: 'navigate' })
      worker.handlers.get('fetch')!({ request, respondWith })
      return respondWith
    }
    const answered = navigate('/channels/general')
    expect(answered).toHaveBeenCalledOnce()
    const response = await answered.mock.calls[0]![0] as Response
    expect(response.headers.get('Content-Security-Policy')).toContain('frame-ancestors')
    expect(navigate('/mcp/authorize')).not.toHaveBeenCalled()
  })

  it('does not intercept an authenticated request for an otherwise public asset', () => {
    const worker = generatedWorker()
    const respondWith = vi.fn()
    worker.handlers.get('fetch')!({ request: new Request(origin + '/_nuxt/client.js', { headers: { Authorization: 'Bearer scoped-session' } }), respondWith })
    expect(respondWith).not.toHaveBeenCalled()
  })

  it.each(['/api/server/session', '/s/alpha/api/messages', '/.well-known/llll', 'https://other.example.com/_nuxt/client.js'])('leaves private and cross-origin traffic on the network: %s', (path) => {
    const worker = generatedWorker()
    const respondWith = vi.fn()
    worker.handlers.get('fetch')!({ request: new Request(new URL(path, origin)), respondWith })
    expect(respondWith).not.toHaveBeenCalled()
  })
})
