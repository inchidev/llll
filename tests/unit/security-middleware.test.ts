import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { fetchMetadataExempt } from '../../server/utils/security-policy'

type TestEvent = {
  method: string
  path: string
  url: string
  headers: Record<string, string | undefined>
  response: Record<string, string>
  status?: number
  context: { cloudflare: { env: Record<string, unknown> } }
}

let middleware: (event: TestEvent) => Promise<unknown>

function database() {
  return {
    prepare() {
      return { all: async () => ({ results: [] }), first: async () => undefined, run: async () => ({}), bind() { return this } }
    },
  } as unknown as D1Database
}

function event(path: string, init: { method?: string, url?: string, headers?: Record<string, string> } = {}): TestEvent {
  const url = init.url ?? 'https://chat.example.com'
  return {
    method: init.method ?? 'GET',
    path,
    url: url + path,
    headers: { host: new URL(url).host, ...init.headers },
    response: {},
    context: { cloudflare: { env: { DB: database(), PUBLIC_ORIGIN: url } } },
  }
}

beforeAll(async () => {
  vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
  vi.stubGlobal('getHeader', (e: TestEvent, name: string) => e.headers[name.toLowerCase()])
  vi.stubGlobal('getRequestURL', (e: TestEvent) => new URL(e.url))
  vi.stubGlobal('setHeader', (e: TestEvent, name: string, value: string) => { e.response[name.toLowerCase()] = value })
  vi.stubGlobal('setResponseStatus', (e: TestEvent, status: number) => { e.status = status })
  middleware = (await import('../../server/middleware/00-security')).default as never
})

afterEach(() => vi.clearAllMocks())

describe('Server security headers', () => {
  it('sends CSP without inline scripts, Permissions-Policy and HSTS on HTTPS', async () => {
    const e = event('/login')
    await middleware(e)
    const scriptSrc = e.response['content-security-policy']!.split('; ').find(part => part.startsWith('script-src '))!
    expect(scriptSrc).toMatch(/^script-src 'self' https:\/\/challenges\.cloudflare\.com 'sha256-[^']+'$/)
    expect(e.response['content-security-policy']).toContain("frame-ancestors 'self' https://llll.gg")
    expect(e.response['permissions-policy']).toContain('camera=(self)')
    expect(e.response['strict-transport-security']).toBe('max-age=31536000')
  })

  it('omits HSTS on local HTTP development', async () => {
    const e = event('/', { url: 'http://localhost:3000' })
    await middleware(e)
    expect(e.response['strict-transport-security']).toBeUndefined()
    expect(e.response['content-security-policy']).toContain('connect-src')
  })

  it('keeps the MCP consent page unframeable', async () => {
    const e = event('/mcp/authorize')
    await middleware(e)
    expect(e.response['content-security-policy']).toContain("frame-ancestors 'none'")
  })
})

describe('Server CSRF boundary', () => {
  const cookie = 'llll-server.session_token=signed'

  it('rejects a cookie POST that has no browser fetch metadata', async () => {
    await expect(middleware(event('/api/channels', { method: 'POST', headers: { cookie } }))).rejects.toMatchObject({ statusCode: 403 })
  })

  it('accepts a same-origin cookie POST', async () => {
    await expect(middleware(event('/api/channels', { method: 'POST', headers: { cookie, origin: 'https://chat.example.com' } }))).resolves.toBeUndefined()
    await expect(middleware(event('/api/channels', { method: 'POST', headers: { cookie, 'sec-fetch-site': 'same-origin' } }))).resolves.toBeUndefined()
  })

  it.each([
    '/api/email/inbound',
    '/api/email/inbound/postmark',
    '/api/compute-agent/poll',
    '/api/agent-runs/00000000-0000-4000-8000-000000000000/gateway/tools',
    '/api/auth/callback/github',
  ])('lets the token-authenticated path %s omit fetch metadata', async (path) => {
    await expect(middleware(event(path, { method: 'POST', headers: { cookie } }))).resolves.toBeUndefined()
  })

  it('exempts MCP only for bearer requests', async () => {
    expect(fetchMetadataExempt('/mcp', 'Bearer abc')).toBe(true)
    expect(fetchMetadataExempt('/mcp', undefined)).toBe(false)
    await expect(middleware(event('/mcp', { method: 'POST', headers: { cookie, authorization: 'Bearer abc' } }))).resolves.toBeUndefined()
    await expect(middleware(event('/mcp', { method: 'POST', headers: { cookie } }))).rejects.toMatchObject({ statusCode: 403 })
  })

  it('still rejects a foreign Origin on exempt paths', async () => {
    await expect(middleware(event('/api/email/inbound', { method: 'POST', headers: { origin: 'https://evil.example' } }))).rejects.toMatchObject({ statusCode: 403 })
  })

  it('answers OAuth backchannel CORS without an Origin check', async () => {
    const e = event('/api/auth/oauth2/token', { method: 'POST', headers: { origin: 'https://client.example' } })
    await expect(middleware(e)).resolves.toBeUndefined()
    expect(e.response['access-control-allow-origin']).toBe('*')
  })
})
