import { beforeAll, describe, expect, it, vi } from 'vitest'
import { originOk } from '../../server/utils/cf'

type TestEvent = {
  method: string
  headers: Record<string, string | undefined>
  context?: {
    cloudflare: {
      env: {
        DB: D1Database
        PUBLIC_ORIGIN?: string
      }
    }
  }
}

type Row = { origin: string, hostname: string, isPrimary: number }
let requestOrigin = 'https://sandbox.llll.gg'

beforeAll(() => {
  vi.stubGlobal('getHeader', (event: TestEvent, name: string) => event.headers[name])
  vi.stubGlobal('getRequestURL', () => new URL(requestOrigin))
})

function db(rows: Row[] = []) {
  return {
    prepare() {
      return {
        all: async () => ({ results: rows }),
        first: async () => undefined,
        run: async () => ({}),
      }
    },
  } as unknown as D1Database
}

function event(value: Partial<TestEvent> & { headers: Record<string, string | undefined> }, rows: Row[] = [], publicOrigin = 'https://primary.example.com') {
  requestOrigin = value.headers.host ? `https://${value.headers.host}` : requestOrigin
  return {
    method: 'POST',
    ...value,
    context: { cloudflare: { env: { DB: db(rows), PUBLIC_ORIGIN: publicOrigin } } },
  } as TestEvent
}

const listed: Row[] = [
  { origin: 'https://primary.example.com', hostname: 'primary.example.com', isPrimary: 1 },
  { origin: 'https://alias.example.com', hostname: 'alias.example.com', isPrimary: 0 },
]

describe('request origin checks', () => {
  it('accepts native requests carrying the non-simple client header', async () => {
    requestOrigin = 'https://sandbox.llll.gg'
    expect(await originOk({
      method: 'POST',
      headers: {
        host: 'sandbox.llll.gg',
        origin: 'capacitor://localhost',
        'x-llll-client': 'native',
      },
    } as never)).toBe(true)
  })

  it('accepts extension requests carrying the non-simple client header', async () => {
    requestOrigin = 'https://sandbox.llll.gg'
    expect(await originOk({
      method: 'POST',
      headers: {
        host: 'sandbox.llll.gg',
        origin: 'chrome-extension://abcdefghijklmnop',
        'x-llll-client': 'extension',
      },
    } as never)).toBe(true)
  })

  it('continues to reject mismatched browser origins', async () => {
    requestOrigin = 'https://sandbox.llll.gg'
    expect(await originOk({
      method: 'POST',
      headers: {
        host: 'sandbox.llll.gg',
        origin: 'https://evil.example',
      },
    } as never)).toBe(false)
  })

  it('accepts a listed alias and its matching browser origin', async () => {
    expect(await originOk(event({
      headers: { host: 'alias.example.com', origin: 'https://alias.example.com' },
    }, listed))).toBe(true)
  })

  it('rejects a removed alias even when its DNS still reaches the Worker', async () => {
    expect(await originOk(event({
      headers: { host: 'removed.example.com', origin: 'https://removed.example.com' },
    }, listed))).toBe(false)
  })

  it('rejects an unknown Host even with an allowed Origin', async () => {
    expect(await originOk(event({
      headers: { host: 'unknown.example.com', origin: 'https://primary.example.com' },
    }, listed))).toBe(false)
  })

  it('rejects a listed hostname on a different port', async () => {
    expect(await originOk(event({
      headers: { host: 'primary.example.com:8443', origin: 'https://primary.example.com:8443' },
    }, listed))).toBe(false)
  })

  it('rejects a listed Host with an unrelated Origin', async () => {
    expect(await originOk(event({
      headers: { host: 'primary.example.com', origin: 'https://evil.example' },
    }, listed))).toBe(false)
  })

  it('uses PUBLIC_ORIGIN before D1 is seeded and never adds the request Host', async () => {
    expect(await originOk(event({
      headers: { host: 'primary.example.com', origin: 'https://primary.example.com' },
    }, []))).toBe(true)
    expect(await originOk(event({
      headers: { host: 'alias.example.com', origin: 'https://alias.example.com' },
    }, []))).toBe(false)
  })
})

describe('fetch metadata on cookie-authenticated unsafe requests', () => {
  const cookie = 'llll-server.session_token=signed'
  const ok = (headers: Record<string, string | undefined>, options?: { allowMissingFetchMetadata?: boolean }) =>
    originOk(event({ headers: { host: 'primary.example.com', ...headers } }, listed) as never, options)

  it('rejects a cookie request that has neither Origin nor Sec-Fetch-Site', async () => {
    expect(await ok({ cookie })).toBe(false)
  })

  it('accepts a cookie request without Origin only from the same origin or a user action', async () => {
    expect(await ok({ cookie, 'sec-fetch-site': 'same-origin' })).toBe(true)
    expect(await ok({ cookie, 'sec-fetch-site': 'none' })).toBe(true)
    expect(await ok({ cookie, 'sec-fetch-site': 'same-site' })).toBe(false)
    expect(await ok({ cookie, 'sec-fetch-site': 'cross-site' })).toBe(false)
  })

  it('accepts a listed Origin and rejects opaque or foreign origins', async () => {
    expect(await ok({ cookie, origin: 'https://primary.example.com', 'sec-fetch-site': 'same-origin' })).toBe(true)
    expect(await ok({ cookie, origin: 'null' })).toBe(false)
    expect(await ok({ cookie, origin: 'https://evil.example', 'sec-fetch-site': 'same-origin' })).toBe(false)
  })

  it('needs no fetch metadata when the request carries no cookie', async () => {
    expect(await ok({})).toBe(true)
    expect(await ok({ authorization: 'Bearer token' })).toBe(true)
  })

  it('never lets the bundled-client header bypass the check for cookie requests', async () => {
    expect(await ok({ cookie, origin: 'capacitor://localhost', 'x-llll-client': 'native' })).toBe(false)
    expect(await ok({ cookie, 'x-llll-client': 'extension' })).toBe(false)
  })

  it('lets an exempt token-authenticated path omit fetch metadata but not send a foreign Origin', async () => {
    expect(await ok({ cookie }, { allowMissingFetchMetadata: true })).toBe(true)
    expect(await ok({ cookie, origin: 'https://evil.example' }, { allowMissingFetchMetadata: true })).toBe(false)
  })
})
