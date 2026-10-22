import { agentProviderIds, agentModelRef, parseAgentModelRef, providerNames, type AgentProviderId, type AgentProviderCatalog, type AgentProviderDTO, type agentProviderSchema } from '../../shared/agent-providers'
import { decryptSecret, encryptSecret, type EncryptedSecret } from '../../shared/encrypted-secret'
import { readServerSetting, writeServerSetting } from '../../shared/server-settings'
import { aiProvider, resolveAgentModelId, type L4Env } from '../../workers/env'
import type { z } from 'zod'
import { fail } from './cf'

type Stored = { enabled: boolean; webSearch?: boolean; models: AgentProviderDTO['models']; secret: EncryptedSecret }
const key = (id: string) => `agents.provider.${id}`
const scope = (id: string) => `agent-provider:${id}`
export async function loadAgentProvider(env: L4Env, id: AgentProviderId): Promise<Stored | null> {
  const value = await readServerSetting(env.DB, key(id))
  return value ? JSON.parse(value) as Stored : null
}
export async function agentProviderCatalog(env: L4Env): Promise<AgentProviderCatalog> {
  const providers = await Promise.all(agentProviderIds.map(async (id): Promise<AgentProviderDTO> => {
    const saved = await loadAgentProvider(env, id)
    return { id, name: providerNames[id], configured: Boolean(saved?.secret), enabled: saved?.enabled ?? false, models: saved?.models ?? [], subscription: id === 'opencode-go', webSearch: saved?.webSearch ?? false }
  }))
  const models = providers.filter(p => p.configured && p.enabled).flatMap(p => p.models.map(m => ({ value: agentModelRef(p.id, m.id), label: m.id, provider: p.name })))
  const imported = providers.some(p => p.id === 'openrouter' && p.configured) && env.AI_BASE_URL?.replace(/\/+$/u, '') === 'https://openrouter.ai/api/v1'
  if (aiProvider(env) && !imported) models.push({ value: resolveAgentModelId(env), label: resolveAgentModelId(env), provider: 'Deployment' })
  const savedDefault = await readServerSetting(env.DB, 'agents.defaultModel')
  return { providers, models, canImportOpenRouter: Boolean(!imported && env.AI_API_KEY && env.AI_MODEL && env.AI_BASE_URL?.replace(/\/+$/u, '') === 'https://openrouter.ai/api/v1'), defaultModel: models.find(m => m.value === savedDefault)?.value ?? models[0]?.value ?? null }
}
export async function saveAgentProvider(env: L4Env, id: AgentProviderId, input: z.infer<typeof agentProviderSchema>): Promise<void> {
  if (!env.AUTH_SECRET || env.AUTH_SECRET.length < 32) fail(503, 'secret_unavailable', 'Server encryption is unavailable')
  const current = await loadAgentProvider(env, id)
  const secret = input.apiKey ? await encryptSecret(env.AUTH_SECRET, scope(id), input.apiKey) : current?.secret
  if (!secret) fail(400, 'key_required', 'Enter an API key')
  if (new Set(input.models.map(m => m.id)).size !== input.models.length) fail(400, 'duplicate_model', 'Model IDs must be unique')
  if (id === 'anthropic' && input.models.some(m => m.api !== 'anthropic')) fail(400, 'invalid_api', 'Claude uses the Anthropic API')
  if (id === 'openrouter' && input.models.some(m => m.api !== 'chat')) fail(400, 'invalid_api', 'OpenRouter uses Chat Completions')
  await writeServerSetting(env.DB, key(id), JSON.stringify({ enabled: input.enabled, webSearch: input.webSearch && id === 'openrouter', models: input.models, secret }))
}
export async function resolveSavedAgentModel(env: L4Env, reference: string) {
  const parsed = parseAgentModelRef(reference)
  if (!parsed) return null
  const provider = await loadAgentProvider(env, parsed.provider)
  const model = provider?.models.find(m => m.id === parsed.model)
  if (!provider?.enabled || !model) fail(409, 'provider_unavailable', 'The selected provider or model is disabled')
  if (!env.AUTH_SECRET) fail(503, 'secret_unavailable', 'Server encryption is unavailable')
  const apiKey = await decryptSecret(env.AUTH_SECRET, scope(parsed.provider), provider.secret)
  return { id: parsed.provider, model, apiKey }
}
