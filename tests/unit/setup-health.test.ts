import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SetupHealth } from '../../shared/types'

const currentUser = vi.fn()
vi.mock('../../server/utils/auth', () => ({ currentUser }))
vi.mock('../../server/utils/agent-providers', () => ({ agentProviderCatalog: async () => ({ defaultModel: 'model-1' }) }))
vi.mock('../../server/utils/agent-run-service', () => ({ piConfigured: async () => false }))
vi.mock('../../workers/realtimekit', () => ({ liveAvailable: async () => true }))
vi.mock('../../server/utils/server-appearance', () => ({
  publicServerAppearance: async (_db: unknown, origin: string, name: string) => ({ id: 'id', name, iconUrl: `${origin}/.well-known/llll/icon`, ready: true }),
}))

type State = { ready: boolean, setup: boolean }
type Health = (event: unknown) => Promise<SetupHealth>
let handler: Health
let headers: Record<string, string>
let sql: string[]

function database(state: State) {
  return {
    prepare(query: string) {
      sql.push(query)
      const first = async () => {
        if (query.includes('server_schema')) return { version: 'server-v2' }
        if (query.includes('COUNT(*)')) return { c: state.ready ? 7 : 0 }
        if (query.includes('FROM server_setup')) return state.setup ? { email: 'owner@example.com', token_hash: 'x', server_name: 'HQ' } : null
        if (query.includes('FROM server')) return state.ready ? { id: 'server' } : null
        if (query.includes('FROM server_domains')) return null
        return null
      }
      return { first, all: async () => ({ results: [] }), run: async () => ({}), bind() { return this } }
    },
  } as unknown as D1Database
}

function event(state: State, url = 'https://attacker-host.example') {
  return {
    method: 'GET',
    url,
    headers: {},
    context: { cloudflare: { env: { DB: database(state), FILES: {}, TICKETS: {}, PUBLIC_ORIGIN: 'https://chat.example.com', AI: {} } } },
  }
}

beforeAll(async () => {
  vi.stubGlobal('defineEventHandler', (fn: unknown) => fn)
  vi.stubGlobal('setHeader', (_event: unknown, name: string, value: string) => { headers[name.toLowerCase()] = value })
  vi.stubGlobal('getRequestURL', (e: { url: string }) => new URL(e.url))
  vi.stubGlobal('getHeader', () => undefined)
  handler = (await import('../../server/api/setup/health.get')).default as unknown as Health
})

beforeEach(() => {
  headers = {}
  sql = []
  currentUser.mockReset()
})

const details = ['users', 'bindings', 'aiProvider', 'aiModel', 'capabilities', 'realtimekit', 'twitterAuth', 'adminEnv'] as const

describe('GET /api/setup/health', () => {
  it('returns only the public status of a set-up Server to anonymous callers', async () => {
    currentUser.mockResolvedValue(null)
    const health = await handler(event({ ready: true, setup: false }))
    expect(health).toMatchObject({ ok: true, ready: true, migrated: true, ownerSetup: false, ownerEmailHint: null })
    expect(health.version).toEqual(expect.any(String))
    for (const field of details) expect(health).not.toHaveProperty(field)
    expect(headers['access-control-allow-origin']).toBeUndefined()
    expect(headers['cache-control']).toBe('no-store')
  })

  it('returns runtime details to signed-in members', async () => {
    currentUser.mockResolvedValue({ id: 'member' })
    const health = await handler(event({ ready: true, setup: false }))
    expect(health).toMatchObject({ users: 7, aiModel: 'model-1', realtimekit: true, bindings: { db: true, r2: true, kv: true } })
    expect(health.capabilities).toBeDefined()
  })

  it('keeps setup diagnostics for an unclaimed Server', async () => {
    currentUser.mockResolvedValue(null)
    const health = await handler(event({ ready: false, setup: true }))
    expect(health).toMatchObject({ ready: false, ownerSetup: true, ownerEmailHint: 'o****@example.com', users: 0, adminEnv: false })
    expect(health.bindings).toMatchObject({ db: true })
    expect(health).not.toHaveProperty('capabilities')
  })

  it('never writes and never derives the Server origin from the request Host', async () => {
    currentUser.mockResolvedValue(null)
    const health = await handler(event({ ready: true, setup: false }))
    expect(sql.every(query => /^\s*SELECT/i.test(query))).toBe(true)
    expect(health.iconUrl).toBe('https://chat.example.com/.well-known/llll/icon')
  })
})
