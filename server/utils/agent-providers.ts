import { workersAiModels } from '../../shared/workers-ai-models'
import { agentProviderIds, agentModelRef, parseAgentModelRef, providerNames, type AgentProviderId, type AgentProviderCatalog, type AgentProviderDTO, type agentProviderSchema } from '../../shared/agent-providers'
import { decryptSecret, encryptSecret, type EncryptedSecret } from '../../shared/encrypted-secret'
import { readServerSetting, writeServerSetting } from '../../shared/server-settings'
import { aiProvider, resolveAgentModelId, type L4Env } from '../../workers/env'
import type { z } from 'zod'
import { fail } from './cf'

export type ChatGPTCredentials = { accessToken: string; refreshToken: string; idToken: string; expiresAt: number; clientId: string; subject: string; email: string; scope: string }
export type StoredAgentProvider = { kind: AgentProviderId; name: string; enabled: boolean; webSearch?: boolean; models: AgentProviderDTO['models']; secret?: EncryptedSecret; keyPreview?: string; connectedBy?: string; account?: string; connectedAt?: string }
export const agentProviderKey = (id: string) => `agents.provider.${id}`
export const agentProviderScope = (id: string) => `agent-provider:${id}`
export async function loadAgentProvider(env: L4Env, id: string): Promise<StoredAgentProvider | null> {
  const value = await readServerSetting(env.DB, agentProviderKey(id))
  if (!value) return null
  const saved = JSON.parse(value) as StoredAgentProvider
  return { ...saved, kind: saved.kind ?? id as AgentProviderId, name: saved.name ?? providerNames[id as AgentProviderId] ?? id }
}
export async function providerDTO(env: L4Env, id: string, saved: StoredAgentProvider, options: { owner?: boolean; actorId?: string } = {}): Promise<AgentProviderDTO | null> {
  const personal = saved.kind === 'chatgpt'
  if (personal && options.actorId && saved.connectedBy && saved.connectedBy !== options.actorId) return null
  return { id, kind: saved.kind, name: saved.name, configured: Boolean(saved.secret), enabled: saved.enabled, models: saved.models, subscription: personal || saved.kind === 'opencode-go', webSearch: saved.webSearch ?? false,
    ...(options.owner ? { keyPreview: saved.keyPreview ?? (!personal && saved.secret && env.AUTH_SECRET ? maskedAgentKey(await decryptSecret(env.AUTH_SECRET, agentProviderScope(id), saved.secret)) : undefined), account: saved.account, connectedAt: saved.connectedAt } : {}), personal }
}
export async function agentProviderPage(env: L4Env, actorId: string, search: string, page: number) {
  const where = "key LIKE 'agents.provider.%' AND (json_extract(value,'$.kind') IS NOT 'chatgpt' OR json_extract(value,'$.connectedBy') IS NULL OR json_extract(value,'$.connectedBy')=?) AND instr(lower(COALESCE(json_extract(value,'$.name'),'')||' '||key),?)>0"
  const count = await env.DB.prepare(`SELECT count(*) as total FROM server_settings WHERE ${where}`).bind(actorId, search.toLowerCase()).first<{ total: number }>()
  const rows = await env.DB.prepare(`SELECT key FROM server_settings WHERE ${where} ORDER BY lower(COALESCE(json_extract(value,'$.name'),key)),key LIMIT 15 OFFSET ?`).bind(actorId, search.toLowerCase(), (page - 1) * 15).all<{ key: string }>()
  const providers = (await Promise.all(rows.results.map(async row => { const id = row.key.slice('agents.provider.'.length); const saved = await loadAgentProvider(env, id); return saved ? providerDTO(env, id, saved, { owner: true, actorId }) : null }))).filter((p): p is AgentProviderDTO => Boolean(p))
  return { providers, total: count?.total ?? 0 }
}
export async function agentProviderCatalog(env: L4Env, options: { owner?: boolean; actorId?: string } = {}): Promise<AgentProviderCatalog> {
  const rows = await env.DB.prepare("SELECT key FROM server_settings WHERE key LIKE 'agents.provider.%' ORDER BY key").all<{ key: string }>()
  const providers = (await Promise.all(rows.results.map(async row => {
    const id = row.key.slice('agents.provider.'.length)
    const saved = await loadAgentProvider(env, id)
    if (!saved || !agentProviderIds.includes(saved.kind)) return null
    return providerDTO(env, id, saved, options)
  }))).filter((p): p is NonNullable<typeof p> => Boolean(p))
  const models = providers.filter(p => p.configured && p.enabled).flatMap(p => p.models.map(m => ({ value: agentModelRef(p.id, m.id), label: m.label ?? m.id, provider: p.name })))
  const imported = providers.some(p => p.kind === 'openrouter' && p.configured) && env.AI_BASE_URL?.replace(/\/+$/u, '') === 'https://openrouter.ai/api/v1'
  if (aiProvider(env) && !imported) {
    if (aiProvider(env) === 'openai-compatible') models.push({ value: resolveAgentModelId(env), label: resolveAgentModelId(env), provider: 'Deployment' })
    else {
      models.push({ value: resolveAgentModelId(env), label: workersAiModels.find(m => m.id === resolveAgentModelId(env))?.label ?? resolveAgentModelId(env), provider: 'Workers AI' })
      models.push(...workersAiModels.filter(m => m.id !== resolveAgentModelId(env)).map(m => ({ value: m.id, label: m.label, provider: 'Workers AI' })))
    }
  }
  const savedDefault = await readServerSetting(env.DB, 'agents.defaultModel')
  return { providers, models, canImportOpenRouter: Boolean(!imported && env.AI_API_KEY && env.AI_MODEL && env.AI_BASE_URL?.replace(/\/+$/u, '') === 'https://openrouter.ai/api/v1'), defaultModel: models.find(m => m.value === savedDefault)?.value ?? models[0]?.value ?? null }
}
export function maskedAgentKey(value: string) { return value.length > 12 ? `${value.slice(0, 4)}••••${value.slice(-4)}` : '••••••••' }
export async function saveAgentProvider(env: L4Env, id: string, input: z.infer<typeof agentProviderSchema>): Promise<void> {
  if (!env.AUTH_SECRET || env.AUTH_SECRET.length < 32) fail(503, 'secret_unavailable', 'Server encryption is unavailable')
  const current = await loadAgentProvider(env, id)
  const kind = input.kind ?? current?.kind ?? id as AgentProviderId
  if (!agentProviderIds.includes(kind) || (current && kind !== current.kind)) fail(400, 'invalid_provider', 'Choose a provider type')
  if (kind === 'chatgpt' && input.apiKey) fail(400, 'oauth_required', 'Use Continue with ChatGPT')
  const secret = input.apiKey ? await encryptSecret(env.AUTH_SECRET, agentProviderScope(id), input.apiKey) : current?.secret
  if (!secret && kind !== 'chatgpt') fail(400, 'key_required', 'Enter an API key')
  if (secret && !input.models.length) fail(400, 'model_required', 'Choose at least one model')
  if (new Set(input.models.map(m => m.id)).size !== input.models.length) fail(400, 'duplicate_model', 'Models must be unique')
  if ((kind === 'anthropic' && input.models.some(m => m.api !== 'anthropic')) || (kind === 'openrouter' && input.models.some(m => m.api !== 'chat')) || (kind === 'chatgpt' && input.models.some(m => m.api !== 'responses'))) fail(400, 'invalid_api', 'The model protocol does not match this provider')
  await writeServerSetting(env.DB, agentProviderKey(id), JSON.stringify({ ...current, kind, name: input.name ?? current?.name ?? providerNames[kind], enabled: input.enabled, webSearch: input.webSearch && kind === 'openrouter', models: input.models, secret, keyPreview: input.apiKey ? maskedAgentKey(input.apiKey) : current?.keyPreview }))
}
export async function resolveSavedAgentModel(env: L4Env, reference: string, actorId?: string) {
  const parsed = parseAgentModelRef(reference)
  if (!parsed) return null
  const provider = await loadAgentProvider(env, parsed.provider)
  const model = provider?.models.find(m => m.id === parsed.model)
  if (!provider?.enabled || !provider.secret || !model) fail(409, 'provider_unavailable', 'The selected provider or model is disabled')
  if (provider.kind === 'chatgpt' && actorId !== provider.connectedBy) fail(403, 'personal_provider', 'This ChatGPT connection belongs to another member')
  if (!env.AUTH_SECRET) fail(503, 'secret_unavailable', 'Server encryption is unavailable')
  const apiKey = await decryptSecret(env.AUTH_SECRET, agentProviderScope(parsed.provider), provider.secret)
  return { id: provider.kind, connectionId: parsed.provider, model, apiKey }
}
