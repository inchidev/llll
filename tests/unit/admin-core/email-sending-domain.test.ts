import { afterEach, describe, expect, it, vi } from 'vitest'
import { ensureEmailSendingDomain } from '../../../packages/admin-core/src/domains'

afterEach(() => vi.unstubAllGlobals())

const zone = { id: 'zone-id', accountId: 'account', name: 'example.com', status: 'active' } as const

function cloudflare(existing: Array<{ tag: string, name: string, enabled: boolean }>, create?: () => Response) {
  const calls: Array<{ method: string, body: unknown }> = []
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    expect(String(input)).toBe('https://api.cloudflare.com/client/v4/zones/zone-id/email/sending/subdomains')
    const method = init?.method || 'GET'
    calls.push({ method, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    if (method === 'GET') return Response.json({ success: true, result: existing })
    return create?.() ?? Response.json({ success: true, result: { tag: 'created-tag', name: 'example.com', enabled: true } })
  }))
  return calls
}

describe('Email Sending onboarding', () => {
  it('onboards the zone apex like any other domain', async () => {
    const calls = cloudflare([])
    await expect(ensureEmailSendingDomain('token', zone, 'example.com')).resolves.toEqual({ createdSubdomainId: 'created-tag', enabled: true })
    expect(calls).toEqual([{ method: 'GET', body: undefined }, { method: 'POST', body: { name: 'example.com' } }])
  })

  it('reuses a domain that is already onboarded and never claims it', async () => {
    const calls = cloudflare([{ tag: 'theirs', name: 'example.com', enabled: true }])
    await expect(ensureEmailSendingDomain('token', zone, 'example.com')).resolves.toEqual({ createdSubdomainId: null, enabled: true })
    expect(calls.map(call => call.method)).toEqual(['GET'])
  })

  it('re-enables a domain whose sending was turned off without claiming it', async () => {
    const calls = cloudflare([{ tag: 'theirs', name: 'mail.example.com', enabled: false }])
    await expect(ensureEmailSendingDomain('token', zone, 'mail.example.com')).resolves.toEqual({ createdSubdomainId: null, enabled: true })
    expect(calls.map(call => call.method)).toEqual(['GET', 'POST'])
  })

  it('stops the connection with a clear reason when Cloudflare refuses', async () => {
    cloudflare([], () => Response.json({ success: false, errors: [{ message: 'Email Sending is not available for this account' }] }, { status: 403 }))
    await expect(ensureEmailSendingDomain('token', zone, 'example.com')).rejects.toMatchObject({
      statusCode: 403,
      statusMessage: 'Cloudflare did not enable Email Sending for example.com: Email Sending is not available for this account',
    })
  })
})
