import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { d1 } from '../helpers/sqlite-d1'
import { INIT_SQL } from '../../server/utils/db'
import { failedTracks, portalSfu, portalSfuApp, SfuError } from '../../server/utils/portal-sfu'
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

afterEach(() => { vi.restoreAllMocks() })

describe('Portal SFU app', () => {
  it('uses the deployment\'s app without asking Cloudflare', async () => {
    const transport = vi.fn(async () => new Response('no', { status: 500 }))
    expect(await portalSfuApp(env({ REALTIME_SFU_APP_ID: ' app ', REALTIME_SFU_APP_TOKEN: 'secret' }), transport as typeof fetch))
      .toEqual({ appId: 'app', appToken: 'secret' })
    expect(transport).not.toHaveBeenCalled()
  })

  it('makes one app with the kept Cloudflare access, keeps it sealed and reuses it', async () => {
    const e = env()
    const transport = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe(`https://api.cloudflare.com/client/v4/accounts/${'a'.repeat(32)}/calls/apps`)
      expect(init?.body).toBe('{"name":"L4 Portal"}')
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer access-token')
      return Response.json({ success: true, result: { uid: 'made-app', secret: 'made-secret', name: 'L4 Portal' } })
    })
    expect(await portalSfuApp(e, transport as typeof fetch)).toEqual({ appId: 'made-app', appToken: 'made-secret' })
    expect(await portalSfuApp(e, transport as typeof fetch)).toEqual({ appId: 'made-app', appToken: 'made-secret' })
    expect(transport).toHaveBeenCalledTimes(1)
    const stored = await e.DB.prepare("SELECT value FROM server_settings WHERE key='portal.sfu-app'").first<{ value: string }>()
    expect(stored?.value).toBeTruthy()
    expect(stored?.value).not.toContain('made-secret')
  })

  it('has no app on a Server it may not provision for, when Cloudflare refuses, or when the answer lacks the secret', async () => {
    const refuse = vi.fn(async () => new Response('no', { status: 403 }))
    expect(await portalSfuApp(env({ LLLL_RUNTIME: 'cloud' } as Partial<L4Env>), refuse as typeof fetch)).toBeNull()
    expect(refuse).not.toHaveBeenCalled()
    expect(await portalSfuApp(env(), refuse as typeof fetch)).toBeNull()
    const half = vi.fn(async () => Response.json({ success: true, result: { uid: 'only-id' } }))
    expect(await portalSfuApp(env(), half as typeof fetch)).toBeNull()
  })
})

describe('Portal SFU calls', () => {
  it('sends the app secret as a bearer token to the app\'s own paths', async () => {
    const calls: string[] = []
    const transport = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push(`${init?.method} ${String(url)} ${new Headers(init?.headers).get('authorization')} ${init?.body ?? ''}`)
      if (String(url).endsWith('/sessions/new')) return Response.json({ sessionId: 'S' }, { status: 201 })
      return Response.json({ tracks: [] })
    })
    const sfu = portalSfu({ appId: 'APP', appToken: 'TOKEN' }, transport as typeof fetch)
    expect(await sfu.newSession()).toBe('S')
    await sfu.renegotiate('S', 'answer-sdp')
    await sfu.close('S', ['0', '1'])
    expect(calls).toEqual([
      'POST https://rtc.live.cloudflare.com/v1/apps/APP/sessions/new Bearer TOKEN ',
      'PUT https://rtc.live.cloudflare.com/v1/apps/APP/sessions/S/renegotiate Bearer TOKEN {"sessionDescription":{"type":"answer","sdp":"answer-sdp"}}',
      'PUT https://rtc.live.cloudflare.com/v1/apps/APP/sessions/S/tracks/close Bearer TOKEN {"tracks":[{"mid":"0"},{"mid":"1"}],"force":true}',
    ])
  })

  it('reads a refusal as an SfuError with the SFU\'s code, and per-track errors apart', async () => {
    const refusing = portalSfu({ appId: 'A', appToken: 'T' }, (async () => Response.json({ errorCode: 'invalid_params', errorDescription: 'nope' }, { status: 406 })) as typeof fetch)
    await expect(refusing.newSession()).rejects.toMatchObject({ name: 'SfuError', code: 'invalid_params' })
    const down = portalSfu({ appId: 'A', appToken: 'T' }, (async () => { throw new Error('offline') }) as typeof fetch)
    await expect(down.renegotiate('S', 'x')).rejects.toBeInstanceOf(SfuError)
    expect(failedTracks({ tracks: [
      { location: 'remote', trackName: 'video', mid: '0' },
      { location: 'remote', trackName: 'audio', errorCode: 'empty_track_error' },
    ] })).toEqual([{ location: 'remote', trackName: 'audio', errorCode: 'empty_track_error' }])
  })
})
