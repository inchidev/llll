import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { d1 } from '../helpers/sqlite-d1'
import { loadAgentProvider, saveAgentProvider } from '../../server/utils/agent-providers'
import { assertAgentModelSupportsTools } from '../../server/utils/agent-model-options'
import { agentProviderSchema } from '../../shared/agent-providers'
import type { L4Env } from '../../workers/env'

let db: DatabaseSync, env: L4Env
beforeEach(() => {
  db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE server_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at TEXT NOT NULL)')
  env = { DB: d1(db), AUTH_SECRET: 'fixture-secret-32-characters-long-only' } as L4Env
})
afterEach(() => db.close())
const models = [{ id: 'vendor/tools', api: 'chat' as const, tools: true }, { id: 'vendor/text-only', api: 'chat' as const, tools: false }, { id: 'vendor/unknown', api: 'chat' as const }]

it('accepts an empty connection name and saves the provider name instead', async () => {
  const input = agentProviderSchema.parse({ kind: 'openrouter', name: '  ', enabled: true, apiKey: 'provider-secret-fixture', models })
  await saveAgentProvider(env, 'work', input)
  expect((await loadAgentProvider(env, 'work'))?.name).toBe('OpenRouter')
  await saveAgentProvider(env, 'work', { ...input, name: 'Work', apiKey: undefined })
  expect((await loadAgentProvider(env, 'work'))?.name).toBe('Work')
  // Omitting the name keeps it; clearing it returns to the provider name.
  await saveAgentProvider(env, 'work', { ...input, name: undefined, apiKey: undefined })
  expect((await loadAgentProvider(env, 'work'))?.name).toBe('Work')
  await saveAgentProvider(env, 'work', { ...input, name: '', apiKey: undefined })
  expect((await loadAgentProvider(env, 'work'))?.name).toBe('OpenRouter')
})

it('explains an overlong connection name instead of a raw length error', () => {
  const result = agentProviderSchema.safeParse({ name: 'x'.repeat(81), enabled: true, models: [] })
  expect(result.success).toBe(false)
  expect(result.error?.issues[0]?.message).toBe('Connection name must be 80 characters or fewer')
})

it('refuses a text-only model for an agent and allows tool-capable or unmarked models', async () => {
  await saveAgentProvider(env, 'work', { kind: 'openrouter', enabled: true, webSearch: false, apiKey: 'provider-secret-fixture', models })
  await expect(assertAgentModelSupportsTools(env, 'l4:work:vendor/text-only')).rejects.toMatchObject({ statusCode: 400, data: { error: { code: 'model_without_tools' } } })
  await expect(assertAgentModelSupportsTools(env, 'l4:work:vendor/tools')).resolves.toBeUndefined()
  await expect(assertAgentModelSupportsTools(env, 'l4:work:vendor/unknown')).resolves.toBeUndefined()
  await expect(assertAgentModelSupportsTools(env, '')).resolves.toBeUndefined()
  await expect(assertAgentModelSupportsTools(env, '@cf/deployment/model')).resolves.toBeUndefined()
})
