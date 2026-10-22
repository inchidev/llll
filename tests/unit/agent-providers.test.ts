import { DatabaseSync } from 'node:sqlite'
import { beforeEach, afterEach, describe, expect, it } from 'vitest'
import { d1 } from '../helpers/sqlite-d1'
import { agentProviderCatalog, loadAgentProvider, resolveSavedAgentModel, saveAgentProvider } from '../../server/utils/agent-providers'
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
})

it.each(['opencode', 'opencode-go'] as const)('routes %s through its own endpoint and stable session header', async (id) => {
  const { vi } = await import('vitest')
  const { modelForRun } = await import('../../workers/ai-runtime')
  const { generateText } = await import('ai')
  await saveAgentProvider(env, id, { enabled: true, webSearch: false, apiKey: 'fixture-token', models: [{ id: 'fixture', api: 'chat' }] })
  const requests: Array<{ url: string; headers: Headers }> = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    requests.push({ url: String(url), headers: new Headers(init.headers) })
    return Response.json({ id: 'test', object: 'chat.completion', created: 0, model: 'fixture', choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })
  }))
  try {
    const model = await modelForRun(env, agentModelRef(id, 'fixture'), 'same-conversation')
    if (typeof model === 'string') throw new Error('Expected configured model')
    expect((await generateText({ model, prompt: 'Hello' })).text).toBe('OK')
    expect(requests[0]!.url).toBe(`https://opencode.ai/inference/${id === 'opencode-go' ? 'go/' : ''}openai/v1/chat/completions`)
    expect(requests[0]!.headers.get('x-opencode-session')).toBe('same-conversation')
    expect(requests[0]!.headers.get('User-Agent')).toContain('l4/pi')
  } finally { vi.unstubAllGlobals() }
})
