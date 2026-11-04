import { agentProviderIds, agentModelRef, parseAgentModelRef, providerNames, type AgentProviderId, type AgentProviderCatalog, type AgentProviderDTO, type agentProviderSchema } from '../../shared/agent-providers'
import { decryptSecret, encryptSecret, type EncryptedSecret } from '../../shared/encrypted-secret'
import { readServerSetting, writeServerSetting } from '../../shared/server-settings'
import { aiProvider, resolveAgentModelId, type L4Env } from '../../workers/env'
import type { z } from 'zod'
import { fail } from './cf'
import { allowedWorkersAiModels, deploymentProviderSetting } from './agent-deployment-provider'

export type ChatGPTCredentials = { accessToken: string; refreshToken: string; idToken: string; expiresAt: number; clientId: string; subject: string; email: string; scope: string }
export type StoredAgentProvider = { kind: AgentProviderId; name: string; enabled: boolean; webSearch?: boolean; shared?: boolean; models: AgentProviderDTO['models']; secret?: EncryptedSecret; keyPreview?: string; connectedBy?: string; account?: string; connectedAt?: string }
/**
 * A ChatGPT connection uses one member's own plan. It stays theirs unless that
 * member shares it with everyone on this Server; only they can change that.
 */
export function chatGPTUsableBy(provider: Pick<StoredAgentProvider, 'connectedBy' | 'shared'>, actorId?: string) {
  return !provider.connectedBy || provider.connectedBy === actorId || provider.shared === true
}
export const agentProviderKey = (id: string) => `agents.provider.${id}`
export const agentProviderScope = (id: string) => `agent-provider:${id}`
export async function loadAgentProvider(env: L4Env, id: string): Promise<StoredAgentProvider | null> {
  const value = await readServerSetting(env.DB, agentProviderKey(id))
  if (!value) return null
  const saved = JSON.parse(value) as StoredAgentProvider
  if (!agentProviderIds.includes(saved.kind ?? id as AgentProviderId)) return null
  return { ...saved, kind: saved.kind ?? id as AgentProviderId, name: saved.name ?? providerNames[id as AgentProviderId] ?? id }
}
export async function providerDTO(env: L4Env, id: string, saved: StoredAgentProvider, options: { owner?: boolean; actorId?: string } = {}): Promise<AgentProviderDTO | null> {
  const personal = saved.kind === 'chatgpt'
  if (personal && options.actorId && saved.connectedBy && !chatGPTUsableBy(saved, options.actorId)) return null
  return { id, kind: saved.kind, name: saved.name, configured: Boolean(saved.secret), enabled: saved.enabled, models: saved.models, subscription: personal, webSearch: saved.webSearch ?? false, shared: personal ? saved.shared === true : undefined, mine: personal ? !saved.connectedBy || saved.connectedBy === options.actorId : undefined,
    ...(options.owner ? { keyPreview: saved.keyPreview ?? (!personal && saved.secret && env.AUTH_SECRET ? maskedAgentKey(await decryptSecret(env.AUTH_SECRET, agentProviderScope(id), saved.secret)) : undefined), account: saved.account, connectedAt: saved.connectedAt } : {}), personal }
}
export async function agentProviderPage(env: L4Env, actorId: string, search: string, page: number) {
  const where = "key LIKE 'agents.provider.%' AND COALESCE(json_extract(value,'$.kind'),substr(key,17)) IN ('openrouter','anthropic','chatgpt') AND (json_extract(value,'$.kind') IS NOT 'chatgpt' OR json_extract(value,'$.connectedBy') IS NULL OR json_extract(value,'$.connectedBy')=? OR json_extract(value,'$.shared')=1) AND instr(lower(COALESCE(json_extract(value,'$.name'),'')||' '||key),?)>0"
  const count = await env.DB.prepare(`SELECT count(*) as total FROM server_settings WHERE ${where}`).bind(actorId, search.toLowerCase()).first<{ total: number }>()
  const rows = await env.DB.prepare(`SELECT key FROM server_settings WHERE ${where} ORDER BY lower(COALESCE(json_extract(value,'$.name'),key)),key LIMIT 15 OFFSET ?`).bind(actorId, search.toLowerCase(), (page - 1) * 15).all<{ key: string }>()
  const providers = (await Promise.all(rows.results.map(async row => { const id = row.key.slice('agents.provider.'.length); const saved = await loadAgentProvider(env, id); return saved ? providerDTO(env, id, saved, { owner: true, actorId }) : null }))).filter((p): p is AgentProviderDTO => Boolean(p))
  return { providers, total: count?.total ?? 0 }
}
export async function agentProviderCatalog(env: L4Env, options: { owner?: boolean; actorId?: string; requireTools?: boolean } = {}): Promise<AgentProviderCatalog> {
  const rows = await env.DB.prepare("SELECT key FROM server_settings WHERE key LIKE 'agents.provider.%' ORDER BY key").all<{ key: string }>()
  const providers = (await Promise.all(rows.results.map(async row => {
    const id = row.key.slice('agents.provider.'.length)
    const saved = await loadAgentProvider(env, id)
    if (!saved || !agentProviderIds.includes(saved.kind)) return null
    return providerDTO(env, id, saved, options)
  }))).filter((p): p is NonNullable<typeof p> => Boolean(p))
  const models = providers.filter(p => p.configured && p.enabled).flatMap(p => p.models.filter(m => options.requireTools === false || m.tools !== false).map(m => ({ value: agentModelRef(p.id, m.id), label: m.label ?? m.id, provider: p.name, ...(m.inputs ? { inputs: m.inputs } : {}), ...(m.outputs ? { outputs: m.outputs } : {}), ...(m.reasoning !== undefined ? { reasoning: m.reasoning } : {}) })))
  const imported = providers.some(p => p.kind === 'openrouter' && p.configured) && env.AI_BASE_URL?.replace(/\/+$/u, '') === 'https://openrouter.ai/api/v1'
  const deploymentSetting = await deploymentProviderSetting(env)
  if (aiProvider(env) && !imported && deploymentSetting.enabled) {
    if (aiProvider(env) === 'openai-compatible') models.push({ value: resolveAgentModelId(env), label: resolveAgentModelId(env), provider: 'Deployment' })
    else {
      const allowed = allowedWorkersAiModels(env, deploymentSetting) ?? []
      // The deployment's own model stays first unless the Owner chose a list without it.
      const own = resolveAgentModelId(env)
      if (!deploymentSetting.models && !allowed.some(m => m.id === own)) models.push({ value: own, label: own, provider: 'Workers AI' })
      models.push(...[...allowed].sort((a, b) => Number(b.id === own) - Number(a.id === own)).map(m => ({ value: m.id, label: m.label, provider: 'Workers AI' })))
    }
  }
  const savedDefault = await readServerSetting(env.DB, 'agents.defaultModel')
  return { providers, models, canImportOpenRouter: Boolean(!imported && env.AI_API_KEY && env.AI_MODEL && env.AI_BASE_URL?.replace(/\/+$/u, '') === 'https://openrouter.ai/api/v1'), defaultModel: savedDefault !== null ? models.find(m => m.value === savedDefault)?.value ?? null : deploymentDefaultModel(env, models, imported), deploymentProvider: aiProvider(env) && !imported ? (aiProvider(env) === 'openai-compatible' ? 'Deployment' : 'Workers AI') : null }
}
export function maskedAgentKey(value: string) { return value.length > 12 ? `${value.slice(0, 4)}••••${value.slice(-4)}` : '••••••••' }

/** Older profiles stored bare IDs. Preserve their endpoint and model, never substitute a default. */
export function catalogAgentModel(env: L4Env, reference: string, catalog: AgentProviderCatalog): string | null {
  if (catalog.models.some(model => model.value === reference)) return reference
  if (parseAgentModelRef(reference)) return null
  const imported = catalog.providers.some(provider => provider.kind === 'openrouter' && provider.configured) && env.AI_BASE_URL?.replace(/\/+$/u, '') === 'https://openrouter.ai/api/v1'
  if (!imported && aiProvider(env) === 'openai-compatible' && !reference.startsWith('@cf/')) return reference
  if (reference.startsWith('@cf/') && aiProvider(env) && aiProvider(env) !== 'openai-compatible') return reference
  const matches = catalog.models.filter(model => parseAgentModelRef(model.value)?.model === reference)
  return matches.length === 1 ? matches[0]!.value : null
}

/** Import the deployment's actual legacy selections along with its credential. */
export async function importOpenRouterDeployment(env: L4Env, webSearch: boolean) {
  if (!(await agentProviderCatalog(env)).canImportOpenRouter) fail(409, 'import_unavailable', 'No OpenRouter deployment credential is available to import')
  const profiles = await env.DB.prepare("SELECT DISTINCT model FROM agents WHERE model<>'' AND model NOT LIKE 'l4:%' AND model NOT LIKE '@cf/%'").all<{ model: string }>()
  const ids = [...new Set([env.AI_MODEL!.trim(), ...profiles.results.map(profile => profile.model)])]
  if (ids.length > 200) fail(409, 'too_many_models', 'Reduce the number of distinct Agent models before importing this connection')
  await saveAgentProvider(env, 'openrouter', { enabled: true, webSearch, apiKey: env.AI_API_KEY!.trim(), models: ids.map(id => ({ id, api: 'chat' })) })
  // Import preserves the operator’s explicit model choice without choosing a catalog fallback.
  if (await readServerSetting(env.DB, 'agents.defaultModel') === null) await writeServerSetting(env.DB, 'agents.defaultModel', agentModelRef('openrouter', env.AI_MODEL!.trim()))
}
export async function saveAgentProvider(env: L4Env, id: string, input: z.infer<typeof agentProviderSchema>, actorId?: string): Promise<void> {
  if (!env.AUTH_SECRET || env.AUTH_SECRET.length < 32) fail(503, 'secret_unavailable', 'Server encryption is unavailable')
  const current = await loadAgentProvider(env, id)
  const kind = input.kind ?? current?.kind ?? id as AgentProviderId
  if (!agentProviderIds.includes(kind) || (current && kind !== current.kind)) fail(400, 'invalid_provider', 'Choose a provider type')
  if (kind === 'chatgpt' && input.apiKey) fail(400, 'oauth_required', 'Use Continue with ChatGPT')
  // Sharing a personal plan is the connecting member's own decision.
  if (input.shared !== undefined && input.shared !== (current?.shared ?? false) && (kind !== 'chatgpt' || !current?.connectedBy || current.connectedBy !== actorId)) fail(403, 'share_denied', 'Only the member who connected this ChatGPT account can share it')
  const secret = input.apiKey ? await encryptSecret(env.AUTH_SECRET, agentProviderScope(id), input.apiKey) : current?.secret
  if (!secret && kind !== 'chatgpt') fail(400, 'key_required', 'Enter an API key')
  if (secret && !input.models.length) fail(400, 'model_required', 'Choose at least one model')
  if (new Set(input.models.map(m => m.id)).size !== input.models.length) fail(400, 'duplicate_model', 'Models must be unique')
  if ((kind === 'anthropic' && input.models.some(m => m.api !== 'anthropic')) || (kind === 'openrouter' && input.models.some(m => m.api !== 'chat')) || (kind === 'chatgpt' && input.models.some(m => m.api !== 'responses'))) fail(400, 'invalid_api', 'The model protocol does not match this provider')
  await writeServerSetting(env.DB, agentProviderKey(id), JSON.stringify({ ...current, kind, name: input.name || (input.name === undefined && current?.name) || providerNames[kind], enabled: input.enabled, webSearch: input.webSearch && kind === 'openrouter', shared: kind === 'chatgpt' ? input.shared ?? current?.shared ?? false : undefined, models: input.models, secret, keyPreview: input.apiKey ? maskedAgentKey(input.apiKey) : current?.keyPreview }))
}
export async function resolveSavedAgentModel(env: L4Env, reference: string, actorId?: string) {
  const parsed = parseAgentModelRef(reference)
  if (!parsed) return null
  const provider = await loadAgentProvider(env, parsed.provider)
  const model = provider?.models.find(m => m.id === parsed.model)
  if (!provider?.enabled || !provider.secret || !model) fail(409, 'provider_unavailable', 'The selected provider or model is disabled')
  if (provider.kind === 'chatgpt' && !chatGPTUsableBy(provider, actorId)) fail(403, 'personal_provider', 'This ChatGPT connection belongs to another member')
  if (!env.AUTH_SECRET) fail(503, 'secret_unavailable', 'Server encryption is unavailable')
  const apiKey = await decryptSecret(env.AUTH_SECRET, agentProviderScope(parsed.provider), provider.secret)
  return { id: provider.kind, connectionId: parsed.provider, model, apiKey }
}

/** Only an operator-supplied model is a deployment default; an AI binding alone is not a choice. */
export function deploymentDefaultModel(env: L4Env, models: { value: string }[], imported = false): string | null {
  if (imported) return null
  const explicit = aiProvider(env) === 'openai-compatible' ? env.AI_MODEL?.trim() : env.AGENT_MODEL?.trim()
  return explicit && models.some(model => model.value === explicit) ? explicit : null
}
