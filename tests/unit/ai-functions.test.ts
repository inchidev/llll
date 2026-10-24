import { DatabaseSync } from 'node:sqlite'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { streamText } from 'ai'
import { d1 } from '../helpers/sqlite-d1'
import { aiFunctionCatalog, aiFunctionKey, inferAiFunction, resolveAiFunction, saveAiFunction } from '../../server/utils/ai-functions'
import { agentProviderCatalog, saveAgentProvider } from '../../server/utils/agent-providers'
import { writeServerSetting } from '../../shared/server-settings'
import { ALL_PERMISSIONS } from '../../shared/permissions'
import type { AuthorizationContext } from '../../shared/authorization'
import type { L4Env } from '../../workers/env'
vi.mock('ai', async original => ({ ...await original<typeof import('ai')>(), streamText: vi.fn() }))
let sqlite: DatabaseSync, env: L4Env
const authorization: AuthorizationContext = { serverId: 'server', principal: { id: 'owner', kind: 'human', roleId: 'role', roleName: 'Owner', isOwner: true, permissions: ALL_PERMISSIONS }, credential: { kind: 'session' } }
const config = { kind: 'openrouter' as const, enabled: true, webSearch: true, apiKey: 'fixture-secret-only', models: [{ id: 'first', api: 'chat' as const }, { id: 'chosen', api: 'chat' as const, tools: false }] }
beforeEach(() => {
  vi.clearAllMocks()
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec('CREATE TABLE server_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at TEXT NOT NULL); CREATE TABLE audit_log(id TEXT,actor_id TEXT,action TEXT,target_type TEXT,target_id TEXT,meta_json TEXT,created_at TEXT)')
  env = { DB: d1(sqlite), AUTH_SECRET: 'fixture-secret-longer-than-32-characters', RATE_LIMIT_DO: { getByName: () => ({ take: async () => true }) } } as unknown as L4Env
})
afterEach(() => sqlite.close())
it('does not inherit an Agent or Server default and allows tool-free function models', async () => {
  await saveAgentProvider(env, 'named', config)
  await writeServerSetting(env.DB, 'agents.defaultModel', 'l4:named:first')
  await expect(resolveAiFunction(env, 'apps.assist', 'owner')).rejects.toMatchObject({ statusCode: 409 })
  await saveAiFunction(env, authorization, 'apps.assist', { model: 'l4:named:chosen' })
  expect(await resolveAiFunction(env, 'apps.assist', 'owner')).toBe('l4:named:chosen')
  expect((await agentProviderCatalog(env)).models.map(model => model.value)).not.toContain('l4:named:chosen')
  expect((await aiFunctionCatalog(env, 'owner')).models.map(model => model.value)).toContain('l4:named:chosen')
  await expect(resolveAiFunction(env, 'thread.title', 'owner')).rejects.toMatchObject({ statusCode: 409 })
})
it('requires owner authorization to assign a model and rejects ambient deployment IDs', async () => {
  await expect(saveAiFunction(env, { ...authorization, principal: { ...authorization.principal, isOwner: false } }, 'apps.assist', { model: null })).rejects.toMatchObject({ statusCode: 403 })
  await expect(saveAiFunction(env, authorization, 'apps.assist', { model: '@cf/model' })).rejects.toMatchObject({ statusCode: 400 })
})
it('fails closed when a selected connection is disabled and never chooses its first model', async () => {
  await saveAgentProvider(env, 'named', config)
  await saveAgentProvider(env, 'other', config)
  await saveAiFunction(env, authorization, 'web.search', { model: 'l4:named:chosen' })
  expect(await resolveAiFunction(env, 'web.search', 'owner')).toBe('l4:named:chosen')
  await saveAgentProvider(env, 'named', { ...config, enabled: false })
  await expect(resolveAiFunction(env, 'web.search', 'owner')).rejects.toMatchObject({ statusCode: 409 })
  expect((await aiFunctionCatalog(env, 'owner')).functions.find(entry => entry.id === 'web.search')?.model).toBe('l4:named:chosen')
})
it('requires explicit web-search enablement and respects later revocation', async () => {
  await saveAgentProvider(env, 'named', { ...config, webSearch: false })
  await expect(saveAiFunction(env, authorization, 'web.search', { model: 'l4:named:first' })).rejects.toMatchObject({ statusCode: 400 })
  await saveAgentProvider(env, 'named', config)
  await saveAiFunction(env, authorization, 'web.search', { model: 'l4:named:first' })
  await saveAgentProvider(env, 'named', { ...config, webSearch: false })
  await expect(resolveAiFunction(env, 'web.search', 'owner')).rejects.toMatchObject({ statusCode: 409 })
})
it('never borrows another Member’s personal subscription', async () => {
  await writeServerSetting(env.DB, 'agents.provider.personal', JSON.stringify({ kind: 'chatgpt', name: 'Private', enabled: true, connectedBy: 'owner', secret: {}, models: [{ id: 'model', api: 'responses' }] }))
  await saveAiFunction(env, authorization, 'apps.assist', { model: 'l4:personal:model' })
  expect((await aiFunctionCatalog(env, 'member')).functions.find(entry => entry.id === 'apps.assist')?.available).toBe(false)
  await expect(resolveAiFunction(env, 'apps.assist', 'member')).rejects.toMatchObject({ statusCode: 409 })
})
it('keeps invalid stored assignments closed instead of guessing a fallback', async () => {
  await writeServerSetting(env.DB, aiFunctionKey('apps.assist'), 'not json')
  await expect(resolveAiFunction(env, 'apps.assist', 'owner')).rejects.toMatchObject({ statusCode: 409 })
})
it('performs one bounded call without tools and audits metadata without prompts or credentials', async () => {
  await saveAgentProvider(env, 'named', config)
  await saveAiFunction(env, authorization, 'apps.assist', { model: 'l4:named:chosen' })
  vi.mocked(streamText).mockReturnValue({ text: Promise.resolve('result'), totalUsage: Promise.resolve({ totalTokens: 12 }) } as ReturnType<typeof streamText>)
  expect(await inferAiFunction(env, authorization, 'apps.assist', 'instructions', 'private-request')).toBe('result')
  expect(vi.mocked(streamText).mock.calls[0]![0]).toMatchObject({ maxOutputTokens: 2000, maxRetries: 0 })
  expect(vi.mocked(streamText).mock.calls[0]![0]).not.toHaveProperty('tools')
  const audit = JSON.stringify(sqlite.prepare('SELECT * FROM audit_log').all())
  expect(audit).toContain('l4:named:chosen')
  expect(audit).not.toContain('private-request')
  expect(audit).not.toContain(config.apiKey)
})
it('redacts upstream failures and does not retry or pick a second model', async () => {
  await saveAgentProvider(env, 'named', config)
  await saveAiFunction(env, authorization, 'apps.assist', { model: 'l4:named:first' })
  vi.mocked(streamText).mockImplementationOnce(() => { throw new Error('Bearer secret; private-request') })
  await expect(inferAiFunction(env, authorization, 'apps.assist', '', 'private-request')).rejects.toMatchObject({ statusCode: 502 })
  expect(streamText).toHaveBeenCalledTimes(1)
  const audit = JSON.stringify(sqlite.prepare('SELECT * FROM audit_log').all())
  expect(audit).not.toContain('Bearer secret')
  expect(audit).not.toContain('private-request')
})
it('classifies credential resolution failures before starting inference', async () => {
  await saveAgentProvider(env, 'named', config)
  await saveAiFunction(env, authorization, 'apps.assist', { model: 'l4:named:first' })
  env.AUTH_SECRET = 'different-fixture-secret-longer-than-32-characters'
  await expect(inferAiFunction(env, authorization, 'apps.assist', '', 'private-request')).rejects.toMatchObject({ statusCode: 502 })
  expect(streamText).not.toHaveBeenCalled()
  const audit = JSON.stringify(sqlite.prepare('SELECT * FROM audit_log').all())
  expect(audit).toContain('failed')
  expect(audit).not.toContain('private-request')
  expect(audit).not.toContain(config.apiKey)
})
