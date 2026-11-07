import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { d1 } from '../helpers/sqlite-d1'
import { saveAgentProvider } from '../../server/utils/agent-providers'
import { agentCompaction, agentContextCeiling, agentModelLimits, unknownModelLimits } from '../../server/utils/agent-model-limits'
import { writeServerSetting } from '../../shared/server-settings'
import type { L4Env } from '../../workers/env'

let db: DatabaseSync
let env: L4Env
beforeEach(() => {
  db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE server_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at TEXT NOT NULL)')
  env = { DB: d1(db), AUTH_SECRET: 'fixture-secret-32-characters-long-only' } as L4Env
})
afterEach(() => db.close())

describe('model limits for a Run', () => {
  it('uses what the provider reported, under the context ceiling and a quarter of it for the answer', async () => {
    await saveAgentProvider(env, 'openrouter', { enabled: true, webSearch: false, apiKey: 'provider-secret-fixture', models: [
      { id: 'vendor/huge', api: 'chat', contextWindow: 1_000_000, maxOutputTokens: 128_000 },
      { id: 'vendor/small', api: 'chat', contextWindow: 8_000, maxOutputTokens: 4_096 },
    ] })
    expect(await agentModelLimits(env, 'l4:openrouter:vendor/huge')).toEqual({ contextWindow: agentContextCeiling, maxOutputTokens: 32_000 })
    expect(await agentModelLimits(env, 'l4:openrouter:vendor/small')).toEqual({ contextWindow: 8_000, maxOutputTokens: 2_000 })
  })

  it("falls back to Pi's catalog for models saved without limits, including dated Claude snapshots", async () => {
    await saveAgentProvider(env, 'anthropic', { enabled: true, webSearch: false, apiKey: 'provider-secret-fixture', models: [
      { id: 'claude-haiku-4-5', api: 'anthropic' }, { id: 'claude-haiku-4-5-20251001', api: 'anthropic' },
    ] })
    // Pi's catalog lists Claude Haiku 4.5 with a 200,000-token window and 64,000-token answers.
    expect(await agentModelLimits(env, 'l4:anthropic:claude-haiku-4-5')).toEqual({ contextWindow: 200_000, maxOutputTokens: 32_000 })
    expect(await agentModelLimits(env, 'l4:anthropic:claude-haiku-4-5-20251001')).toEqual({ contextWindow: 200_000, maxOutputTokens: 32_000 })
  })

  it('keeps a reported window and takes only the missing answer limit from the catalog', async () => {
    await writeServerSetting(env.DB, 'agents.provider.anthropic', JSON.stringify({ kind: 'anthropic', name: 'Claude', enabled: true,
      secret: { ciphertext: 'x', iv: 'x', version: 1 }, models: [{ id: 'claude-haiku-4-5', api: 'anthropic', contextWindow: 100_000 }] }))
    expect(await agentModelLimits(env, 'l4:anthropic:claude-haiku-4-5')).toEqual({ contextWindow: 100_000, maxOutputTokens: 25_000 })
  })

  it('reads deployment models from the Workers AI and OpenRouter catalogs, and guesses generously otherwise', async () => {
    const workersAi = await agentModelLimits(env, '@cf/deepseek-ai/deepseek-v4-flash-0731')
    expect(workersAi.contextWindow).toBe(agentContextCeiling)
    const viaOpenRouter = await agentModelLimits({ ...env, AI_BASE_URL: 'https://openrouter.ai/api/v1/' }, 'anthropic/claude-haiku-4.5')
    expect(viaOpenRouter).toEqual({ contextWindow: 200_000, maxOutputTokens: 32_000 })
    expect(await agentModelLimits(env, 'private-model')).toEqual(unknownModelLimits)
    expect(await agentModelLimits(env, 'l4:missing:model')).toEqual(unknownModelLimits)
  })

  it("scales Pi's compaction thresholds to the window", () => {
    expect(agentCompaction({ contextWindow: 200_000, maxOutputTokens: 32_000 })).toEqual({ reserveTokens: 32_000, keepRecentTokens: 20_000, backgroundTokens: 25_000 })
    expect(agentCompaction({ contextWindow: 128_000, maxOutputTokens: 8_192 })).toEqual({ reserveTokens: 16_384, keepRecentTokens: 20_000, backgroundTokens: 16_000 })
    const small = agentCompaction({ contextWindow: 8_000, maxOutputTokens: 2_000 })
    expect(small).toEqual({ reserveTokens: 2_000, keepRecentTokens: 1_600, backgroundTokens: 1_000 })
    expect(small.reserveTokens + small.keepRecentTokens + small.backgroundTokens).toBeLessThan(8_000)
  })
})
