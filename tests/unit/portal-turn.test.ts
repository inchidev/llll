import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { d1 } from '../helpers/sqlite-d1'
import { INIT_SQL } from '../../server/utils/db'
import { portalIceServers, portalTurnKey } from '../../server/utils/portal-turn'
import type { L4Env } from '../../workers/env'

vi.mock('../../server/utils/cloudflare-account-access', () => ({
  cloudflareAccessStatus: vi.fn(async () => ({ connected: true, kind: 'oauth', accountId: 'a'.repeat(32), connectedAt: '' })),
  cloudflareAccessToken: vi.fn(async () => ({ token: 'access-token', accountId: 'a'.repeat(32) })),
}))

function env(extra: Partial<L4Env> = {}): L4Env {
  const db = new DatabaseSync(':memory:')
  db.exec(INIT_SQL)
  return { DB: d1(db), AUTH_SECRET: 'test-server-secret-with-32-characters', ...extra } as unknown as L4Env
}

const generated = { iceServers: [
  { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.cloudflare.com:53'] },
  { urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turn:turn.cloudflare.com:53?transport=udp', 'turns:turn.cloudflare.com:443?transport=tcp'], username: 'user', credential: 'secret' },
] }

afterEach(() => { vi.restoreAllMocks() })

describe('Portal TURN', () => {
  it('uses the deployment\'s key and leaves out port 53', async () => {
    const calls: string[] = []
    const transport = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push(`${String(url)} ${String(init?.body)} ${new Headers(init?.headers).get('authorization')}`)
      return Response.json(generated, { status: 201 })
    })
    const servers = await portalIceServers(env({ REALTIME_TURN_KEY_ID: 'kid', REALTIME_TURN_KEY_API_TOKEN: 'ktoken' }), 3600, transport as typeof fetch)
    expect(calls).toEqual(['https://rtc.live.cloudflare.com/v1/turn/keys/kid/credentials/generate-ice-servers {"ttl":3600} Bearer ktoken'])
    expect(servers).toEqual([
      { urls: ['stun:stun.cloudflare.com:3478'] },
      { urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turns:turn.cloudflare.com:443?transport=tcp'], username: 'user', credential: 'secret' },
    ])
  })

  it('makes one key with the kept Cloudflare access, keeps it sealed and reuses it', async () => {
    const e = env()
    const transport = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith('/calls/turn_keys')) return Response.json({ success: true, result: { uid: 'made-id', key: 'made-token', name: 'L4 Portal' } })
      return Response.json(generated, { status: 201 })
    })
    expect(await portalTurnKey(e, transport as typeof fetch)).toEqual({ keyId: 'made-id', apiToken: 'made-token' })
    expect(await portalTurnKey(e, transport as typeof fetch)).toEqual({ keyId: 'made-id', apiToken: 'made-token' })
    expect(transport.mock.calls.filter(([url]) => String(url).endsWith('/calls/turn_keys'))).toHaveLength(1)
    const stored = await e.DB.prepare("SELECT value FROM server_settings WHERE key='portal.turn-key'").first<{ value: string }>()
    expect(stored?.value).not.toContain('made-token')
  })

  it('has no TURN on a Server it may not provision for, and none when Cloudflare refuses', async () => {
    const transport = vi.fn(async () => new Response('no', { status: 403 }))
    expect(await portalIceServers(env({ LLLL_RUNTIME: 'cloud' } as Partial<L4Env>), 3600, transport as typeof fetch)).toBeNull()
    expect(transport).not.toHaveBeenCalled()
    expect(await portalIceServers(env(), 3600, transport as typeof fetch)).toBeNull()
  })
})
