import { afterEach, describe, expect, it, vi } from 'vitest'
import { encryptSecret } from '../../shared/encrypted-secret'
import type { L4Env } from '../../workers/env'
import {
  connectRealtimeKit,
  LLLL_HOST_PRESET,
  LLLL_PARTICIPANT_PRESET,
  endMeeting,
  loadRealtimeKitConfig,
  REALTIMEKIT_SECRET_SCOPE,
  realtimekitConfigured,
  realtimekitSettingsAdminDto,
  removeParticipants,
  testRealtimeKitConnection,
  type RealtimeKitRuntimeConfig,
} from '../../workers/realtimekit'

const API = 'https://api.cloudflare.com/client/v4'

const managedConfig = {
  accountId: 'account',
  appId: 'app',
  apiToken: 'token',
  hostPreset: LLLL_HOST_PRESET,
  participantPreset: LLLL_PARTICIPANT_PRESET,
  source: 'database',
  apiTokenConfigured: true,
  secretReadable: true,
} satisfies RealtimeKitRuntimeConfig

function envWithRow(row: Record<string, unknown> | null, extra: Partial<L4Env> = {}): L4Env {
  return {
    DB: {
      prepare: () => ({ first: async () => row }),
    },
    ...extra,
  } as unknown as L4Env
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify({ success: status < 400, result: data }), { status, headers: { 'Content-Type': 'application/json' } })
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('RealtimeKit meetings', () => {
  it('ends the active provider session before deactivating its meeting', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => json({}))

    await endMeeting(managedConfig, 'meeting')

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      `${API}/accounts/account/realtime/kit/app/meetings/meeting/active-session/kick-all`,
      expect.objectContaining({ method: 'POST' }),
    )
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      `${API}/accounts/account/realtime/kit/app/meetings/meeting`,
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ status: 'INACTIVE' }) }),
    )
  })

  it('still deactivates a meeting whose active session has already ended', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json(null, 404))
      .mockResolvedValueOnce(json({}))

    await expect(endMeeting(managedConfig, 'meeting')).resolves.toBeUndefined()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('treats a meeting that no longer exists as ended', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(null, 404))

    await expect(endMeeting(managedConfig, 'meeting')).resolves.toBeUndefined()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('does not clear provider failures as successful cleanup', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(null, 403))

    await expect(endMeeting(managedConfig, 'meeting')).rejects.toThrow('RealtimeKit HTTP 403')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('removes people from the session and revokes their tokens', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => json({}))

    await removeParticipants(managedConfig, 'meeting', ['p1'])

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      `${API}/accounts/account/realtime/kit/app/meetings/meeting/active-session/kick`,
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ participant_ids: ['p1'] }) }),
    )
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      `${API}/accounts/account/realtime/kit/app/meetings/meeting/participants/p1`,
      expect.objectContaining({ method: 'DELETE' }),
    )
  })

  it('revokes a token even when its session has already ended', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json(null, 404))
      .mockResolvedValueOnce(json({}))

    await expect(removeParticipants(managedConfig, 'meeting', ['p1'])).resolves.toBeUndefined()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

describe('RealtimeKit settings', () => {
  it('prefers complete deployment variables without reading D1', async () => {
    const env = {
      DB: { prepare: () => { throw new Error('D1 should not be read') } },
      REALTIMEKIT_ACCOUNT_ID: 'account',
      REALTIMEKIT_APP_ID: 'app',
      REALTIMEKIT_API_TOKEN: 'token',
      REALTIMEKIT_PRESET_HOST: 'team-host',
      REALTIMEKIT_PRESET_PARTICIPANT: 'team-guest',
    } as unknown as L4Env

    const config = await loadRealtimeKitConfig(env)

    expect(config).toMatchObject({
      accountId: 'account',
      appId: 'app',
      apiToken: 'token',
      source: 'deployment',
      hostPreset: 'team-host',
      participantPreset: 'team-guest',
    })
    expect(realtimekitConfigured(config)).toBe(true)
  })

  it('decrypts owner-connected credentials from D1', async () => {
    const serverSecret = 'a sufficiently long server secret'
    const encrypted = await encryptSecret(serverSecret, REALTIMEKIT_SECRET_SCOPE, 'cloudflare-token')
    const config = await loadRealtimeKitConfig(envWithRow({
      account_id: 'account',
      app_id: 'app',
      api_token_ciphertext: encrypted.ciphertext,
      api_token_iv: encrypted.iv,
      api_token_version: encrypted.version,
      host_preset: LLLL_HOST_PRESET,
      participant_preset: LLLL_PARTICIPANT_PRESET,
    }, { AUTH_SECRET: serverSecret }))

    expect(config.apiToken).toBe('cloudflare-token')
    expect(config.source).toBe('database')
    expect(realtimekitConfigured(config)).toBe(true)
    const dto = realtimekitSettingsAdminDto(config)
    expect(dto).not.toHaveProperty('apiToken')
    expect(dto.sharedPreset).toBe(false)
  })

  it('flags settings saved when everyone shared one preset', async () => {
    const config = await loadRealtimeKitConfig(envWithRow({
      account_id: 'account',
      app_id: 'app',
      api_token_ciphertext: 'x',
      api_token_iv: 'x',
      api_token_version: 1,
      host_preset: 'group_call_host',
      participant_preset: 'group_call_host',
    }))

    expect(realtimekitSettingsAdminDto(config).sharedPreset).toBe(true)
  })

  it('reports an unreadable saved token after AUTH_SECRET changes', async () => {
    const encrypted = await encryptSecret('original server secret', REALTIMEKIT_SECRET_SCOPE, 'cloudflare-token')
    const config = await loadRealtimeKitConfig(envWithRow({
      account_id: 'account',
      app_id: 'app',
      api_token_ciphertext: encrypted.ciphertext,
      api_token_iv: encrypted.iv,
      api_token_version: encrypted.version,
      host_preset: LLLL_HOST_PRESET,
      participant_preset: LLLL_PARTICIPANT_PRESET,
    }, { AUTH_SECRET: 'rotated server secret' }))

    expect(config.apiTokenConfigured).toBe(true)
    expect(config.secretReadable).toBe(false)
    expect(realtimekitConfigured(config)).toBe(false)
  })

  it('stays optional before the settings migration exists', async () => {
    const env = {
      DB: { prepare: () => ({ first: async () => { throw new Error('no such table') } }) },
    } as unknown as L4Env

    await expect(loadRealtimeKitConfig(env)).resolves.toMatchObject({ source: 'missing', apiTokenConfigured: false })
  })

  it('tests the token, app, and both presets without creating a meeting', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json([
      { name: LLLL_HOST_PRESET },
      { name: LLLL_PARTICIPANT_PRESET },
    ]))

    await expect(testRealtimeKitConnection(managedConfig)).resolves.toEqual({
      presets: [LLLL_HOST_PRESET, LLLL_PARTICIPANT_PRESET],
    })
    expect(fetchMock).toHaveBeenCalledWith(
      `${API}/accounts/account/realtime/kit/app/presets?per_page=100`,
      expect.objectContaining({ method: 'GET', headers: expect.objectContaining({ Authorization: 'Bearer token' }) }),
    )
  })

  it('reports presets that do not exist', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json([{ name: LLLL_HOST_PRESET }]))

    await expect(testRealtimeKitConnection(managedConfig)).rejects.toThrow(`RealtimeKit preset not found: ${LLLL_PARTICIPANT_PRESET}`)
  })
})

describe('connecting Live with one token', () => {
  function route(handlers: Record<string, () => Response>) {
    const calls: Array<{ method: string, url: string, body: unknown }> = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined })
      const key = `${method} ${url.replace(API, '')}`
      const handler = handlers[key]
      if (!handler) throw new Error(`Unexpected ${key}`)
      return handler()
    })
    return calls
  }

  it('creates the server app and both presets in the only account', async () => {
    const calls = route({
      'GET /accounts?per_page=50': () => json([{ id: 'acct', name: 'Team' }]),
      'GET /accounts/acct/realtime/kit/apps': () => new Response(JSON.stringify({ success: true, data: [] })),
      'POST /accounts/acct/realtime/kit/apps': () => new Response(JSON.stringify({ success: true, data: { app: { id: 'app-1', name: 'L4 chat.example.com' } } })),
      'GET /accounts/acct/realtime/kit/app-1/presets?per_page=100': () => new Response(JSON.stringify({ success: true, data: [] })),
      'POST /accounts/acct/realtime/kit/app-1/presets': () => json({ id: 'preset' }),
    })

    await expect(connectRealtimeKit('token', { appName: 'L4 chat.example.com' })).resolves.toEqual({
      accountId: 'acct',
      appId: 'app-1',
      hostPreset: LLLL_HOST_PRESET,
      participantPreset: LLLL_PARTICIPANT_PRESET,
    })
    const presets = calls.filter(call => call.method === 'POST' && call.url.endsWith('/presets'))
      .map(call => call.body as { name: string, permissions: { kick_participant: boolean, can_record: boolean } })
    expect(presets.map(preset => [preset.name, preset.permissions.kick_participant, preset.permissions.can_record])).toEqual([
      [LLLL_HOST_PRESET, true, false],
      [LLLL_PARTICIPANT_PRESET, false, false],
    ])
  })

  it('reuses an existing app and presets when reconnecting', async () => {
    const calls = route({
      'GET /accounts?per_page=50': () => json([{ id: 'acct', name: 'Team' }]),
      'GET /accounts/acct/realtime/kit/apps': () => new Response(JSON.stringify({ success: true, data: [{ id: 'app-1', name: 'L4 chat.example.com' }] })),
      'GET /accounts/acct/realtime/kit/app-1/presets?per_page=100': () => new Response(JSON.stringify({
        success: true,
        data: [{ name: LLLL_HOST_PRESET }, { name: LLLL_PARTICIPANT_PRESET }],
      })),
    })

    await expect(connectRealtimeKit('token', { appName: 'L4 chat.example.com' })).resolves.toMatchObject({ appId: 'app-1' })
    expect(calls.every(call => call.method === 'GET')).toBe(true)
  })

  it('asks which account to use when the token reaches several', async () => {
    route({
      'GET /accounts?per_page=50': () => json([{ id: 'a', name: 'One' }, { id: 'b', name: 'Two' }]),
    })

    await expect(connectRealtimeKit('token', { appName: 'L4' })).resolves.toEqual({
      accounts: [{ id: 'a', name: 'One' }, { id: 'b', name: 'Two' }],
    })
  })
})

it('bounds RealtimeKit REST operations and forwards cancellation to the transport', async () => {
  const controller = new AbortController()
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal)
  const transport = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, options) => new Promise<Response>((_resolve, reject) => {
    options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true })
  }))
  const request = endMeeting(managedConfig, 'meeting')
  const settled = expect(request).rejects.toThrow('timed out')
  expect(timeout).toHaveBeenCalledWith(10000)
  expect(transport.mock.calls[0]?.[1]?.signal).toBe(controller.signal)
  controller.abort(new Error('timed out'))
  await settled
})
