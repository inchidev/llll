import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { L4Env } from '../../workers/env'

const calls: string[] = []
const ensureMigrated = vi.fn(async () => { calls.push('migrate'); return true })
const ensureAdminFromEnv = vi.fn(async () => { calls.push('admin'); return { users: 1, provisioned: false } })
const readOwnerSetup = vi.fn(async () => { calls.push('owner'); return null })
vi.mock('../../server/utils/db', () => ({ ensureMigrated }))
vi.mock('../../server/utils/bootstrap', () => ({ ensureAdminFromEnv }))
vi.mock('../../server/utils/owner-setup', () => ({ readOwnerSetup }))

const { ensureServerStarted } = await import('../../server/utils/server-startup')
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
  it('initialises once per database from deployment configuration', async () => {
    const db = database()
    const env = { DB: db, PUBLIC_ORIGIN: 'https://chat.example.com' }
    await Promise.all([ensureServerStarted(event(env)), ensureServerStarted(event(env))])
    await ensureServerStarted(event(env))
    expect(calls).toEqual(['migrate', 'admin', 'owner'])
    expect(db.statements).toContain('batch')
  })

  it('retries after a failed start without failing the request', async () => {
    ensureMigrated.mockRejectedValueOnce(new Error('requires a fresh server-v2 database'))
    const db = database()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await ensureServerStarted(event({ DB: db }))).toBe(false)
    expect(await ensureServerStarted(event({ DB: db }))).toBe(true)
    expect(ensureMigrated).toHaveBeenCalledTimes(2)
    warn.mockRestore()
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
