import { DatabaseSync } from 'node:sqlite'
import { beforeEach, afterEach, describe, expect, it } from 'vitest'
import { d1 } from '../helpers/sqlite-d1'
import { agentProviderCatalog, catalogAgentModel, importOpenRouterDeployment, loadAgentProvider, resolveSavedAgentModel, saveAgentProvider } from '../../server/utils/agent-providers'
import { agentModelRef } from '../../shared/agent-providers'
import { writeServerSetting } from '../../shared/server-settings'
import { agentConversationModel, agentConversationModelKey } from '../../server/utils/agent-conversation-model'
import type { L4Env } from '../../workers/env'
let db: DatabaseSync
let env: L4Env
beforeEach(() => {
  db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE server_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at TEXT NOT NULL); CREATE TABLE channels(id TEXT PRIMARY KEY,parent_id TEXT);')
  env = { DB: d1(db), AUTH_SECRET: 'fixture-secret-32-characters-long-only' } as L4Env
})
afterEach(() => db.close())
const config = { enabled: true, webSearch: true, apiKey: 'provider-secret-fixture', models: [{ id: 'vendor/model', api: 'chat' as const }] }
describe('Server model credentials', () => {
  it('encrypts credentials, keeps DTOs secret-free, and preserves a key when omitted', async () => {
    await saveAgentProvider(env, 'openrouter', config)
    const stored = await loadAgentProvider(env, 'openrouter')
    expect(JSON.stringify(stored)).not.toContain(config.apiKey)
    const catalog = await agentProviderCatalog(env)
    expect(JSON.stringify(catalog)).not.toContain(config.apiKey)
    expect(catalog.defaultModel).toBe('l4:openrouter:vendor/model')
    await saveAgentProvider(env, 'openrouter', { ...config, apiKey: undefined })
    expect((await resolveSavedAgentModel(env, catalog.defaultModel!))?.apiKey).toBe(config.apiKey)
  })
  it('fails closed on disabled providers and cannot decrypt with another Server secret', async () => {
    await saveAgentProvider(env, 'openrouter', config)
    const ref = agentModelRef('openrouter', config.models[0]!.id)
    await expect(resolveSavedAgentModel({ ...env, AUTH_SECRET: 'another-server-secret-32-characters' }, ref)).rejects.toThrow()
    await saveAgentProvider(env, 'openrouter', { ...config, enabled: false })
    expect((await agentProviderCatalog(env)).models).toHaveLength(0)
    await expect(resolveSavedAgentModel(env, ref)).rejects.toMatchObject({ statusCode: 409 })
  })
  it('does not fall back to the deployment key after importing and disabling OpenRouter', async () => {
    Object.assign(env, { AI_BASE_URL: 'https://openrouter.ai/api/v1', AI_API_KEY: 'deployment-key', AI_MODEL: 'old/model' })
    expect((await agentProviderCatalog(env)).canImportOpenRouter).toBe(true)
    await saveAgentProvider(env, 'openrouter', { ...config, enabled: false })
    expect((await agentProviderCatalog(env)).models).toHaveLength(0)
  })
  it('threads inherit their parent conversation model without changing another conversation', async () => {
    db.exec("INSERT INTO channels VALUES ('dm',NULL),('thread','dm'),('other',NULL)")
    await writeServerSetting(env.DB, await agentConversationModelKey(env, 'thread'), 'l4:openrouter:chosen')
    expect(await agentConversationModel(env, 'dm')).toBe('l4:openrouter:chosen')
    expect(await agentConversationModel(env, 'thread')).toBe('l4:openrouter:chosen')
    expect(await agentConversationModel(env, 'other')).toBeNull()
  })
  it('imports every legacy profile selection and keeps disabled models unavailable', async () => {
    db.exec("CREATE TABLE agents(model TEXT); INSERT INTO agents VALUES('custom/model'),('l4:other:configured'),('@cf/model'),('')")
    Object.assign(env, { AI_BASE_URL: 'https://openrouter.ai/api/v1', AI_API_KEY: 'deployment-key', AI_MODEL: 'default/model' })
    await importOpenRouterDeployment(env, false)
    const catalog = await agentProviderCatalog(env)
    expect(catalogAgentModel(env, 'custom/model', catalog)).toBe('l4:openrouter:custom/model')
    expect((await resolveSavedAgentModel(env, 'l4:openrouter:custom/model'))?.apiKey).toBe('deployment-key')
    expect(catalog.models.map(model => model.value)).toEqual(['l4:openrouter:default/model', 'l4:openrouter:custom/model'])
    await saveAgentProvider(env, 'openrouter', { ...config, enabled: false })
    await saveAgentProvider(env, 'other-connection', { ...config, kind: 'anthropic', name: 'Deployment', models: [{ id: 'claude', api: 'anthropic' }] })
    expect(catalogAgentModel(env, 'custom/model', await agentProviderCatalog(env))).toBeNull()
  })
  it('refuses to guess which connection owns an ambiguous legacy model ID', async () => {
    for (const id of ['first', 'second']) await saveAgentProvider(env, id, { ...config, kind: 'openrouter' })
    expect(catalogAgentModel(env, 'vendor/model', await agentProviderCatalog(env))).toBeNull()
  })
})

it('keeps independently named connections and exposes key fragments only to the owner', async () => {
  await saveAgentProvider(env, 'work-account', { ...config, kind: 'openrouter', name: 'Work' })
  await saveAgentProvider(env, 'personal-account', { ...config, kind: 'openrouter', name: 'Personal', apiKey: 'different-credential' })
  const owner = await agentProviderCatalog(env, { owner: true })
  expect(owner.providers.map(p => p.name)).toEqual(['Personal', 'Work'])
  expect(owner.providers.find(p => p.name === 'Work')?.keyPreview).toBe('prov••••ture')
  expect(JSON.stringify(await agentProviderCatalog(env))).not.toContain('prov••••ture')
  expect((await resolveSavedAgentModel(env, agentModelRef('personal-account', 'vendor/model')))?.apiKey).toBe('different-credential')
})

it('paginates named connections and searches models on the Server while retaining a selection outside the first page', async () => {
  const { agentProviderPage } = await import('../../server/utils/agent-providers')
  const { agentModelOptions } = await import('../../server/utils/agent-model-options')
  for (let i = 0; i < 18; i++) await saveAgentProvider(env, `connection-${String(i).padStart(2, '0')}`, { ...config, kind: 'openrouter', name: `Work ${i}`, models: Array.from({ length: 4 }, (_, j) => ({ id: `model-${i}-${j}`, label: `Model ${i} ${j}`, api: 'chat' })) })
  const first = await agentProviderPage(env, 'owner', '', 1)
  expect(first.providers).toHaveLength(15); expect(first.total).toBe(18)
  expect((await agentProviderPage(env, 'owner', '', 2)).providers).toHaveLength(3)
  expect((await agentProviderPage(env, 'owner', 'Work 17', 1)).total).toBe(1)
  const catalog = await agentModelOptions(env, 'owner', '', 'l4:connection-17:model-17-3')
  expect(catalog.models.length).toBeLessThanOrEqual(51)
  expect(catalog.models.some(m => m.value === 'l4:connection-17:model-17-3')).toBe(true)
  expect(catalog.hasMore).toBe(true)
  expect((await agentModelOptions(env, 'owner', 'Model 17 3')).models.filter(m => m.label === 'Model 17 3')).toHaveLength(1)
})
