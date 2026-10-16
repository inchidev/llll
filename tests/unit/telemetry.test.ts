import { describe, expect, it, vi } from 'vitest'
import { sendTelemetryHeartbeat, telemetryHeartbeat } from '../../server/utils/telemetry'
import type { L4Env } from '../../workers/env'

function env(overrides: Partial<L4Env> = {}) {
  return {
    DB: {
      prepare: vi.fn(() => ({ first: vi.fn(async () => ({ enabled: 1 })) })),
    },
    FILES: {},
    TICKETS: {},
    AI: {},
    AGENT_DO: {},
    LLLL_VERSION: '0.2.0',
    LLLL_TELEMETRY_ID: '019c-test-installation',
    LLLL_TELEMETRY_TOKEN: 'private-token',
    LLLL_APP_HOSTNAME: 'chat.example.com',
    LLLL_CUSTOM_DOMAIN: 'true',
    ...overrides,
  } as unknown as L4Env
}

describe('anonymous telemetry', () => {
  it('contains capability flags but no workspace identity or activity', () => {
    const heartbeat = telemetryHeartbeat(env(), '2026-09-05T12:00:00.000Z')
    expect(heartbeat).toMatchObject({
      schemaVersion: 1,
      installationId: '019c-test-installation',
      version: '0.2.0',
      capabilities: { d1: true, r2: true, kv: true, customDomain: true, email: false, agents: true, huddles: false },
    })
    expect(JSON.stringify(heartbeat)).not.toMatch(/workspace|message|member|domainName|emailAddress/)
  })

  it('does not call the endpoint after opt-out', async () => {
    const fetcher = vi.fn()
    const disabled = env({
      DB: { prepare: vi.fn(() => ({ first: vi.fn(async () => ({ enabled: 0 })) })) } as unknown as D1Database,
    })
    await expect(sendTelemetryHeartbeat(disabled, fetcher)).resolves.toBe('disabled')
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('authenticates and sends an enabled heartbeat', async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 204 }))
    await expect(sendTelemetryHeartbeat(env(), fetcher)).resolves.toBe('sent')
    expect(fetcher).toHaveBeenCalledWith('https://llll.gg/api/telemetry/heartbeat', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ Authorization: 'Bearer private-token' }),
    }))
  })

  it('reports Live when RealtimeKit is connected from settings or the deployment', () => {
    expect(telemetryHeartbeat(env(), undefined, true)?.capabilities.huddles).toBe(true)
  })

  it('reports Agents from Workers AI and the Agent Durable Object', () => {
    const heartbeat = telemetryHeartbeat(env())
    expect(heartbeat?.capabilities.agents).toBe(true)
  })

  it('reports Agents that use an OpenAI-compatible endpoint', () => {
    const heartbeat = telemetryHeartbeat(env({
      AI: undefined,
      AI_BASE_URL: 'https://llm.example.com/v1',
      AI_API_KEY: 'secret',
      AI_MODEL: 'your-model',
    }))
    expect(heartbeat?.capabilities.agents).toBe(true)
  })

  it('does not report Agents without inference or an Agent Durable Object', () => {
    const heartbeat = telemetryHeartbeat(env({ AI: undefined, AGENT_DO: undefined }))
    expect(heartbeat?.capabilities.agents).toBe(false)
  })
})
