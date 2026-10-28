import { beforeAll, describe, expect, it, vi } from 'vitest'
import { clientIp, requireRateLimit } from '../../server/utils/rate-limit'

type Limiter = (key: string) => Promise<boolean>
function event(headers: Record<string, string>, env: Record<string, unknown>, limiter?: Limiter) {
  const RATE_LIMIT_DO = limiter && { getByName: (key: string) => ({ take: () => limiter(key) }) }
  return { headers, context: { cloudflare: { env: { DB: {}, ...env, ...(RATE_LIMIT_DO ? { RATE_LIMIT_DO } : {}) } } } } as never
}

beforeAll(() => {
  vi.stubGlobal('getHeader', (e: { headers: Record<string, string> }, name: string) => e.headers[name])
  vi.stubGlobal('getRequestIP', () => '10.0.0.9')
})

describe('clientIp', () => {
  it('trusts CF-Connecting-IP only on Cloudflare', () => {
    expect(clientIp(event({ 'cf-connecting-ip': '198.51.100.7' }, { LLLL_RUNTIME: 'cloudflare' }))).toBe('198.51.100.7')
    expect(clientIp(event({ 'cf-connecting-ip': '203.0.113.1', 'x-forwarded-for': '192.0.2.4' }, { LLLL_RUNTIME: 'celld' }))).toBe('192.0.2.4')
  })

  it('uses the address the nearest proxy appended, not a client-supplied prefix', () => {
    expect(clientIp(event({ 'x-forwarded-for': '203.0.113.1, 192.0.2.4' }, { LLLL_RUNTIME: 'celld' }))).toBe('192.0.2.4')
    expect(clientIp(event({}, { LLLL_RUNTIME: 'celld' }))).toBe('10.0.0.9')
  })
})

describe('requireRateLimit', () => {
  const rules = [{ key: 'ip:a:login', limit: 5, windowMs: 1000 }, { key: 'account:x:login', limit: 20, windowMs: 1000 }]

  it('refuses when any budget is exhausted', async () => {
    await expect(requireRateLimit(event({}, {}, async key => key.startsWith('ip:')), rules, 'Too many')).rejects.toMatchObject({ statusCode: 429 })
    await expect(requireRateLimit(event({}, {}, async () => true), rules, 'Too many')).resolves.toBeUndefined()
  })

  it('fails closed when the limiter is unavailable', async () => {
    await expect(requireRateLimit(event({}, {}, async () => { throw new Error('down') }), rules, 'Too many')).rejects.toMatchObject({ statusCode: 503 })
  })

  it('skips only when no limiter binding exists at all', async () => {
    await expect(requireRateLimit(event({}, {}), rules, 'Too many')).resolves.toBeUndefined()
  })
})
