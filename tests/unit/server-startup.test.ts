import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { L4Env } from '../../workers/env'

const calls: string[] = []
const ensureMigrated = vi.fn(async () => { calls.push('migrate'); return true })
const ensureAdminFromEnv = vi.fn(async () => { calls.push('admin'); return { users: 1, provisioned: false } })
const readOwnerSetup = vi.fn(async () => { calls.push('owner'); return null })
vi.mock('../../server/utils/db', () => ({ ensureMigrated }))
vi.mock('../../server/utils/bootstrap', () => ({ ensureAdminFromEnv }))
vi.mock('../../server/utils/owner-setup', () => ({ readOwnerSetup }))

const { ensureServerStarted, STARTUP_TAKEOVER_MS } = await import('../../server/utils/server-startup')
const { ensurePrimaryServerOrigin } = await import('../../server/utils/server-origins')

function database() {
  const statements: string[] = []
  return {
    statements,
    prepare(sql: string) {
      statements.push(sql)
      return { first: async () => null, all: async () => ({ results: [] }), run: async () => ({}), bind() { return this } }
    },
    async batch() { statements.push('batch'); return [] },
  } as unknown as D1Database & { statements: string[] }
}

const event = (env: Partial<L4Env>) => ({ context: { cloudflare: { env } } }) as never

beforeEach(() => {
  calls.length = 0
  vi.clearAllMocks()
})

describe('Server startup', () => {
  it('lets a request through a set-up Server after one round trip, and finishes in the background', async () => {
    const db = database()
    Object.assign(db, { batch: async () => { db.statements.push('check'); return [{ results: [{ version: 'server-v1' }] }, { results: [{ c: 1 }] }, { results: [{ c: 1 }] }] } })
    const background: Promise<unknown>[] = []
    const waitUntil = (work: Promise<unknown>) => void background.push(work)
    const env = { DB: db, PUBLIC_ORIGIN: 'https://chat.example.com' }
    const started = ensureServerStarted({ context: { cloudflare: { env, context: { waitUntil } } } } as never)
    await expect(started).resolves.toBe(true)
    expect(db.statements).toEqual(expect.arrayContaining(['check']))
    expect(background).toHaveLength(1)
    await Promise.all(background)
    expect(calls).toEqual(['migrate', 'admin', 'owner'])
  })

  it('initialises once per database from deployment configuration', async () => {
    const db = database()
    const env = { DB: db, PUBLIC_ORIGIN: 'https://chat.example.com' }
    await Promise.all([ensureServerStarted(event(env)), ensureServerStarted(event(env))])
    await ensureServerStarted(event(env))
    expect(calls).toEqual(['migrate', 'admin', 'owner'])
    expect(db.statements).toContain('batch')
  })

  it('retries after a failed start without failing the request', async () => {
    ensureMigrated.mockRejectedValueOnce(new Error('requires a fresh server-v1 database'))
    const db = database()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await ensureServerStarted(event({ DB: db }))).toBe(false)
    expect(await ensureServerStarted(event({ DB: db }))).toBe(true)
    expect(ensureMigrated).toHaveBeenCalledTimes(2)
    warn.mockRestore()
  })

  it('stops waiting for a start that never finishes, and tries again on the next request', async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      ensureMigrated.mockImplementationOnce(() => new Promise<boolean>(() => {}))
      const db = database()
      const waiting = ensureServerStarted(event({ DB: db }))
      await vi.advanceTimersByTimeAsync(30_000)
      expect(await waiting).toBe(false)
      expect(warn).toHaveBeenCalledWith('server.startup.stalled', { waitedMs: 30_000 })
      expect(await ensureServerStarted(event({ DB: db }))).toBe(true)
      expect(ensureMigrated).toHaveBeenCalledTimes(2)
    } finally { vi.useRealTimers(); warn.mockRestore() }
  })

  it('takes over a start whose request has gone, instead of waiting on its promise', async () => {
    vi.useFakeTimers()
    try {
      // The request that began this start ended, so on Workers its promise never settles.
      ensureMigrated.mockImplementationOnce(() => new Promise<boolean>(() => {}))
      const db = database()
      void ensureServerStarted(event({ DB: db }))
      const next = ensureServerStarted(event({ DB: db }))
      await vi.advanceTimersByTimeAsync(STARTUP_TAKEOVER_MS)
      expect(await next).toBe(true)
      expect(ensureMigrated).toHaveBeenCalledTimes(2)
    } finally { vi.useRealTimers() }
  })

  it('does nothing without runtime bindings', async () => {
    expect(await ensureServerStarted({ context: {} } as never)).toBe(false)
  })
})

describe('primary origin seeding', () => {
  it('never stores an origin when PUBLIC_ORIGIN is not configured', async () => {
    const db = database()
    await ensurePrimaryServerOrigin({ DB: db } as unknown as L4Env)
    expect(db.statements).toEqual([])
  })

  it('stores the configured PUBLIC_ORIGIN', async () => {
    const db = database()
    await ensurePrimaryServerOrigin({ DB: db, PUBLIC_ORIGIN: 'https://chat.example.com' } as unknown as L4Env)
    expect(db.statements).toContain('batch')
  })
})
