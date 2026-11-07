import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { d1 } from '../helpers/sqlite-d1'
import { saveAgentProvider } from '../../server/utils/agent-providers'
import { agentCompaction, agentContextCeiling, agentModelLimitDetails, agentModelLimits, unknownModelLimits } from '../../server/utils/agent-model-limits'
import { deploymentProviderSetting, deploymentProviderState, saveDeploymentProvider } from '../../server/utils/agent-deployment-provider'
import { resolveModelLimits } from '../../shared/agent-model-limits'
import { agentProviderSchema } from '../../shared/agent-providers'
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

  it('takes each limit from the provider, then the Owner, then the catalog, then the default', () => {
    expect(resolveModelLimits({})).toEqual({ ...unknownModelLimits, sources: { contextWindow: 'default', maxOutputTokens: 'default' } })
    expect(resolveModelLimits({ reported: { contextWindow: 64_000 }, owner: { contextWindow: 32_000, maxOutputTokens: 4_000 }, catalog: { contextWindow: 16_000, maxOutputTokens: 2_000 } }))
      .toEqual({ contextWindow: 64_000, maxOutputTokens: 4_000, sources: { contextWindow: 'reported', maxOutputTokens: 'owner' } })
    expect(resolveModelLimits({ owner: { maxOutputTokens: 6_000 }, catalog: { contextWindow: 40_000, maxOutputTokens: 2_000 } }))
      .toEqual({ contextWindow: 40_000, maxOutputTokens: 6_000, sources: { contextWindow: 'catalog', maxOutputTokens: 'owner' } })
    // An Owner's figures obey the same ceilings as anyone's.
    expect(resolveModelLimits({ owner: { contextWindow: 1_000_000, maxOutputTokens: 100_000 } })).toMatchObject({ contextWindow: agentContextCeiling, maxOutputTokens: 32_000 })
  })

  it('uses the limits the Owner set for a saved model whose provider reported none, never over what it reported', async () => {
    await saveAgentProvider(env, 'anthropic', agentProviderSchema.parse({ enabled: true, apiKey: 'provider-secret-fixture', models: [
      { id: 'claude-haiku-4-5', api: 'anthropic', limits: { contextWindow: 60_000, maxOutputTokens: 6_000 } },
      { id: 'private-claude', api: 'anthropic', limits: { contextWindow: 50_000 } },
      { id: 'reported-claude', api: 'anthropic', contextWindow: 90_000, maxOutputTokens: 9_000, limits: { contextWindow: 10_000, maxOutputTokens: 2_000 } },
    ] }))
    // The Owner's setting comes before Pi's catalog, which knows Claude Haiku 4.5 as 200,000 tokens.
    expect(await agentModelLimitDetails(env, 'l4:anthropic:claude-haiku-4-5')).toEqual({ contextWindow: 60_000, maxOutputTokens: 6_000, sources: { contextWindow: 'owner', maxOutputTokens: 'owner' } })
    expect(await agentModelLimitDetails(env, 'l4:anthropic:private-claude')).toEqual({ contextWindow: 50_000, maxOutputTokens: unknownModelLimits.maxOutputTokens, sources: { contextWindow: 'owner', maxOutputTokens: 'default' } })
    expect(await agentModelLimits(env, 'l4:anthropic:reported-claude')).toEqual({ contextWindow: 90_000, maxOutputTokens: 9_000 })
    expect(agentProviderSchema.safeParse({ enabled: true, models: [{ id: 'x', limits: { contextWindow: 10 } }] }).success).toBe(false)
    expect(agentProviderSchema.safeParse({ enabled: true, models: [{ id: 'x', limits: { contextWindow: 50_000, extra: 1 } }] }).success).toBe(false)
  })

  it('keeps the deployment model’s Owner limits as a Server setting, for that model only', async () => {
    const deployment = { ...env, AI_BASE_URL: 'https://models.example/v1', AI_API_KEY: 'deployment-key', AI_MODEL: 'private-model' } as L4Env
    await saveDeploymentProvider(deployment, { enabled: true, models: null, limits: { model: 'private-model', contextWindow: 64_000, maxOutputTokens: 4_000 } })
    expect(await agentModelLimitDetails(deployment, 'private-model')).toEqual({ contextWindow: 64_000, maxOutputTokens: 4_000, sources: { contextWindow: 'owner', maxOutputTokens: 'owner' } })
    // Another deployment model, after the operator changed AI_MODEL, does not inherit them.
    expect(await agentModelLimits(deployment, 'another-model')).toEqual(unknownModelLimits)
    expect(await deploymentProviderState(deployment)).toMatchObject({ name: 'Deployment', deploymentModel: 'private-model', limits: { owner: { contextWindow: 64_000, maxOutputTokens: 4_000 }, catalog: null } })
    // A save that names no limits keeps them; null clears them.
    await saveDeploymentProvider(deployment, { enabled: false, models: null })
    expect((await deploymentProviderSetting(deployment)).limits).toEqual({ model: 'private-model', contextWindow: 64_000, maxOutputTokens: 4_000 })
    await saveDeploymentProvider(deployment, { enabled: true, models: null, limits: null })
    expect(await agentModelLimits(deployment, 'private-model')).toEqual(unknownModelLimits)
  })

  it("scales Pi's compaction thresholds to the window", () => {
    expect(agentCompaction({ contextWindow: 200_000, maxOutputTokens: 32_000 })).toEqual({ reserveTokens: 32_000, keepRecentTokens: 20_000, backgroundTokens: 25_000 })
    expect(agentCompaction({ contextWindow: 128_000, maxOutputTokens: 8_192 })).toEqual({ reserveTokens: 16_384, keepRecentTokens: 20_000, backgroundTokens: 16_000 })
    const small = agentCompaction({ contextWindow: 8_000, maxOutputTokens: 2_000 })
    expect(small).toEqual({ reserveTokens: 2_000, keepRecentTokens: 1_600, backgroundTokens: 1_000 })
    expect(small.reserveTokens + small.keepRecentTokens + small.backgroundTokens).toBeLessThan(8_000)
  })
})
