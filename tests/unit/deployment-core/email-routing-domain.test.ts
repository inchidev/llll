import { afterEach, describe, expect, it, vi } from 'vitest'
import { ensureEmailRoutingDomain, ensureMailboxRoute, removeMailboxRoute } from '../../../packages/deployment-core/src/domains'

afterEach(() => vi.unstubAllGlobals())

const zone = { id: 'zone-id', accountId: 'account', name: 'example.com', status: 'active' } as const

function cloudflare(mx: string[], enable?: () => Response) {
  const calls: Array<{ method: string, path: string, body?: string }> = []
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    calls.push({ method: init?.method || 'GET', path: url.pathname.replace('/client/v4', ''), body: init?.body ? String(init.body) : undefined })
    if (url.pathname.endsWith('/dns_records')) {
      expect(url.searchParams.get('type')).toBe('MX')
      return Response.json({ success: true, result: mx.map(content => ({ type: 'MX', content })) })
    }
    return enable?.() ?? Response.json({ success: true, result: {} })
  }))
  return calls
}

describe('Email Routing onboarding', () => {
  it('needs no Zone Settings permission on a domain that already routes through Cloudflare', async () => {
    const calls = cloudflare(['route1.mx.cloudflare.net', 'route2.mx.cloudflare.net'])
    await ensureEmailRoutingDomain('token', zone, 'example.com')
    expect(calls.map(call => call.method)).toEqual(['GET'])
  })

  it('turns routing on for the zone apex without a body', async () => {
    const calls = cloudflare([])
    await ensureEmailRoutingDomain('token', zone, 'example.com')
    expect(calls[1]).toEqual({ method: 'POST', path: '/zones/zone-id/email/routing/dns', body: undefined })
  })

  it('names the subdomain it turns routing on for', async () => {
    const calls = cloudflare([])
    await ensureEmailRoutingDomain('token', zone, 'mail.example.com')
    expect(calls[1]?.body).toBe(JSON.stringify({ name: 'mail.example.com' }))
  })

  it('says how to continue when the grant cannot turn routing on', async () => {
    cloudflare([], () => Response.json({ success: false, errors: [{ message: 'Authentication error' }] }, { status: 403 }))
    await expect(ensureEmailRoutingDomain('token', zone, 'example.com')).rejects.toMatchObject({
      statusCode: 403,
      statusMessage: 'Cloudflare did not turn on Email Routing for example.com: Authentication error. Turn it on for this domain in your Cloudflare dashboard, then connect again.',
    })
  })
})

describe('Mailbox routes', () => {
  const rule = (id: string, address: string, worker: string) => ({ id, matchers: [{ type: 'literal', field: 'to', value: address }], actions: [{ type: 'worker', value: [worker] }] })

  function rules(existing: unknown[]) {
    const calls: Array<{ method: string, path: string, body?: unknown }> = []
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input))
      const method = init?.method || 'GET'
      calls.push({ method, path: url.pathname.replace('/client/v4', ''), body: init?.body ? JSON.parse(String(init.body)) : undefined })
      return Response.json({ success: true, result: method === 'GET' ? existing : { id: 'new' } })
    }))
    return calls
  }

  it('creates a rule that sends the address to this Worker', async () => {
    const calls = rules([])
    await ensureMailboxRoute('token', 'zone-id', 'server', 'Hello@example.com')
    expect(calls[1]).toMatchObject({ method: 'POST', body: { enabled: true, matchers: [{ value: 'hello@example.com' }], actions: [{ type: 'worker', value: ['server'] }] } })
  })

  it('keeps a rule that already reaches this Worker', async () => {
    const calls = rules([rule('r1', 'hello@example.com', 'server')])
    await ensureMailboxRoute('token', 'zone-id', 'server', 'hello@example.com')
    expect(calls).toHaveLength(1)
  })

  it('removes only this Worker\'s rule for the address', async () => {
    const calls = rules([rule('r1', 'hello@example.com', 'server'), rule('r2', 'other@example.com', 'server')])
    await removeMailboxRoute('token', 'zone-id', 'server', 'hello@example.com')
    expect(calls.filter(call => call.method === 'DELETE').map(call => call.path)).toEqual(['/zones/zone-id/email/routing/rules/r1'])
  })

  it('leaves a rule that belongs to another Worker', async () => {
    const calls = rules([rule('r1', 'hello@example.com', 'other')])
    await removeMailboxRoute('token', 'zone-id', 'server', 'hello@example.com')
    expect(calls.map(call => call.method)).toEqual(['GET'])
  })
})
