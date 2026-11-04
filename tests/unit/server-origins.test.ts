import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  normalizeServerOrigin,
  parseServerOriginList,
} from '../../shared/server-origins'
import { serverDiscovery } from '../../shared/server-discovery'
import {
  createServerDomainRequest,
  hashServerDomainToken,
  readServerOrigins,
} from '../../server/utils/server-origins'
import { authRequestContext } from '../../server/utils/better-auth'
import type { L4Env } from '../../workers/env'
import type { H3Event } from 'h3'

type OriginRow = { origin: string, hostname: string, isPrimary: number }
type Bound = { sql: string, params: unknown[] }

function fakeDb(rows: OriginRow[] = [], options: { primary?: boolean } = {}) {
  const calls: string[] = []
  const batch: Bound[] = []
  const db = {
    calls,
    batchItems: batch,
    prepare(sql: string) {
      calls.push(sql)
      const statement = {
        bind(...params: unknown[]) {
          return { sql, params, all: async () => ({ results: rows }), first: async () => undefined, run: async () => ({}) }
        },
        all: async () => ({ results: rows }),
        first: async () => options.primary ? { present: 1 } : undefined,
        run: async () => ({}),
      }
      return statement
    },
    async batch(items: Bound[]) {
      calls.push('batch')
      batch.push(...items)
      return []
    },
  }
  return db as unknown as D1Database & { calls: string[], batchItems: Bound[] }
}

function env(db: D1Database, values: Partial<L4Env> = {}): L4Env {
  return { DB: db, ...values } as L4Env
}

afterEach(() => vi.unstubAllGlobals())

describe('server origin parsing', () => {
  it('normalizes an exact HTTP or HTTPS origin and rejects paths and credentials', () => {
    expect(normalizeServerOrigin(' https://Chat.Example.com/ ')).toBe('https://chat.example.com')
    expect(normalizeServerOrigin('http://localhost:3000')).toBe('http://localhost:3000')
    for (const value of ['chat.example.com', 'ftp://chat.example.com', 'https://user:pass@chat.example.com', 'https://chat.example.com/app', 'https://chat.example.com?x=1', 'https://chat.example.com/#x']) {
      expect(() => normalizeServerOrigin(value)).toThrow()
    }
  })

  it('reads a comma- or space-separated list and ignores malformed entries', () => {
    expect(parseServerOriginList('https://a.example.com, https://b.example.com\nnot-an-origin https://a.example.com')).toEqual([
      'https://a.example.com',
      'https://b.example.com',
    ])
  })
})

describe('origin authority', () => {
  it('uses server_domains as the authority for Cloudflare-managed Servers', async () => {
    const db = fakeDb([
      { origin: 'https://primary.example.com', hostname: 'primary.example.com', isPrimary: 1 },
      { origin: 'https://alias.example.com', hostname: 'alias.example.com', isPrimary: 0 },
    ])
    const origins = await readServerOrigins(env(db, {
      PUBLIC_ORIGIN: 'https://removed.example.com',
      LLLL_ORIGINS: 'https://environment.example.com',
    }))
    expect(origins).toEqual([
      { origin: 'https://primary.example.com', hostname: 'primary.example.com', primary: true },
      { origin: 'https://alias.example.com', hostname: 'alias.example.com', primary: false },
    ])
  })

  it('uses PUBLIC_ORIGIN and LLLL_ORIGINS on celld and ignores stale D1 rows', async () => {
    const db = fakeDb([
      { origin: 'https://removed.example.com', hostname: 'removed.example.com', isPrimary: 1 },
    ])
    const origins = await readServerOrigins(env(db, {
      LLLL_RUNTIME: 'celld',
      PUBLIC_ORIGIN: 'https://primary.example.com',
      LLLL_ORIGINS: 'https://alias.example.com, https://primary.example.com',
    }))
    expect(origins).toEqual([
      { origin: 'https://primary.example.com', hostname: 'primary.example.com', primary: true },
      { origin: 'https://alias.example.com', hostname: 'alias.example.com', primary: false },
    ])
    expect(db.calls).toEqual([])
  })

  it('falls back to PUBLIC_ORIGIN only when D1 has no rows, and never trusts the request Host', async () => {
    const db = fakeDb([])
    const origins = await readServerOrigins(env(db, { PUBLIC_ORIGIN: 'https://primary.example.com' }), 'https://unknown.example.com')
    expect(origins).toEqual([
      { origin: 'https://primary.example.com', hostname: 'primary.example.com', primary: true },
    ])
  })

  it('keeps a computed fallback for a Server with no D1 rows or PUBLIC_ORIGIN', async () => {
    const db = fakeDb([])
    const origins = await readServerOrigins(env(db), 'https://fallback.example.com')
    expect(origins).toEqual([
      { origin: 'https://fallback.example.com', hostname: 'fallback.example.com', primary: true },
    ])
  })
})

describe('domain request tokens', () => {
  it('stores only a hash of the single-use token', async () => {
    const db = fakeDb([])
    const created = await createServerDomainRequest(env(db), { action: 'add', hostname: 'chat.example.com' })
    const insert = db.batchItems.find(item => item.sql.includes('INSERT INTO server_domain_requests'))
    expect(insert).toBeTruthy()
    expect(insert!.params).not.toContain(created.token)
    expect(insert!.params).toContain(await hashServerDomainToken(created.token))
    expect(created.token.length).toBeGreaterThanOrEqual(32)
  })
})

describe('server discovery aliases', () => {
  const id = '20bce15e-c83c-4f92-b90d-cee8eab23ce5'
  const discovery = {
    product: 'llll',
    kind: 'server',
    apiVersion: 2,
    id,
    name: 'Community',
    origin: 'https://primary.example.com',
    aliases: ['https://alias.example.com'],
    ready: true,
    version: '0.2.5',
  }

  it('accepts an alias probe and reports the primary with every alias', () => {
    expect(serverDiscovery(discovery, 'https://alias.example.com')).toMatchObject({
      id,
      origin: 'https://primary.example.com',
      aliases: ['https://alias.example.com'],
    })
  })

  it('rejects an unrelated host and ignores malformed aliases', () => {
    expect(() => serverDiscovery(discovery, 'https://evil.example.com')).toThrow('compatible')
    const data = { ...discovery, aliases: ['not an origin', 'https://alias.example.com', 'https://alias.example.com'] }
    expect(serverDiscovery(data, 'https://alias.example.com').aliases).toEqual(['https://alias.example.com'])
  })
})

describe('auth request context', () => {
  it('uses a listed alias as the base URL and trusts every listed origin', async () => {
    const db = fakeDb([
      { origin: 'https://primary.example.com', hostname: 'primary.example.com', isPrimary: 1 },
      { origin: 'https://alias.example.com', hostname: 'alias.example.com', isPrimary: 0 },
    ])
    vi.stubGlobal('getRequestURL', () => new URL('https://alias.example.com/api/auth/session'))
    const event = { context: { cloudflare: { env: env(db, { PUBLIC_ORIGIN: 'https://primary.example.com' }) } } } as unknown as H3Event
    await expect(authRequestContext(event)).resolves.toEqual({
      baseURL: 'https://alias.example.com',
      origins: ['https://primary.example.com', 'https://alias.example.com'],
    })
  })

  it('falls back to the primary for an unknown host instead of trusting it', async () => {
    const db = fakeDb([
      { origin: 'https://primary.example.com', hostname: 'primary.example.com', isPrimary: 1 },
    ])
    vi.stubGlobal('getRequestURL', () => new URL('https://unknown.example.com/api/auth/session'))
    const event = { context: { cloudflare: { env: env(db, { PUBLIC_ORIGIN: 'https://primary.example.com' }) } } } as unknown as H3Event
    await expect(authRequestContext(event)).resolves.toEqual({
      baseURL: 'https://primary.example.com',
      origins: ['https://primary.example.com'],
    })
  })
})
