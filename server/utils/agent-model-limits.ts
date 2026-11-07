import { parseAgentModelRef, type AgentProviderId } from '../../shared/agent-providers'
import { resolveModelLimits, type AgentModelLimitDetails, type AgentModelLimits } from '../../shared/agent-model-limits'
import { loadAgentProvider } from './agent-providers'
import { deploymentProviderSetting } from './agent-deployment-provider'
import type { L4Env } from '../../workers/env'

export { agentContextCeiling, unknownModelLimits, type AgentModelLimits } from '../../shared/agent-model-limits'

type CatalogModel = { contextWindow?: number; maxTokens?: number }
type Catalog = Readonly<Record<string, CatalogModel>>
type CatalogKind = AgentProviderId | 'workers-ai'

/** Pi's own model catalog, one provider at a time, so a Worker loads only what a Run uses. */
const catalogs: Record<CatalogKind, () => Promise<Catalog>> = {
  anthropic: () => import('@earendil-works/pi-ai/providers/anthropic.models').then(module => module.ANTHROPIC_MODELS as unknown as Catalog),
  chatgpt: () => import('@earendil-works/pi-ai/providers/openai-codex.models').then(module => module.OPENAI_CODEX_MODELS as unknown as Catalog),
  openrouter: () => import('@earendil-works/pi-ai/providers/openrouter.models').then(module => module.OPENROUTER_MODELS as unknown as Catalog),
  'workers-ai': () => import('@earendil-works/pi-ai/providers/cloudflare-workers-ai.models').then(module => module.CLOUDFLARE_WORKERS_AI_MODELS as unknown as Catalog),
}

/** Pi's catalog entry for a model, as limits; Anthropic's API lists dated snapshots of the aliases the catalog names. */
function catalogEntry(catalog: Catalog, id: string) {
  const model = catalog[id] ?? catalog[id.replace(/-\d{8}$/u, '')]
  return model ? { contextWindow: model.contextWindow, maxOutputTokens: model.maxTokens } : undefined
}
async function catalogModel(kind: CatalogKind | undefined, id: string) {
  return kind ? catalogEntry(await catalogs[kind](), id) : undefined
}
/** What Pi's catalog says about each of these models, for Settings to show beside the provider's own figures. */
export async function catalogModelLimits(kind: AgentProviderId, ids: readonly string[]) {
  const catalog = await catalogs[kind]()
  return Object.fromEntries(ids.flatMap(id => { const entry = catalogEntry(catalog, id); return entry ? [[id, entry]] : [] }))
}
/** The catalog that knows a deployment model: Workers AI, or OpenRouter behind an OpenAI-compatible endpoint. */
function deploymentCatalog(env: Pick<L4Env, 'AI_BASE_URL'>, reference: string): CatalogKind | undefined {
  if (reference.startsWith('@cf/')) return 'workers-ai'
  return env.AI_BASE_URL?.trim().replace(/\/+$/u, '') === 'https://openrouter.ai/api/v1' ? 'openrouter' : undefined
}

/** What Pi's catalog says about a deployment model, or nothing when no catalog knows it. */
export async function deploymentCatalogLimits(env: Pick<L4Env, 'AI_BASE_URL'>, reference: string) {
  return catalogModel(deploymentCatalog(env, reference), reference)
}

/**
 * A model's limits and where each came from: what its provider reported when it was saved, then what the Owner set
 * in Server settings → Models (on the saved model, or for the deployment's model next to its provider settings),
 * then Pi's catalog, then a generous default. See `resolveModelLimits`.
 */
export async function agentModelLimitDetails(env: Pick<L4Env, 'DB' | 'AI_BASE_URL'>, reference: string): Promise<AgentModelLimitDetails> {
  const parsed = parseAgentModelRef(reference)
  if (parsed) {
    const provider = await loadAgentProvider(env as L4Env, parsed.provider)
    const saved = provider?.models.find(model => model.id === parsed.model)
    const known = resolveModelLimits({ reported: saved, owner: saved?.limits })
    const catalog = Object.values(known.sources).includes('default') ? await catalogModel(provider?.kind, parsed.model) : undefined
    return resolveModelLimits({ reported: saved, owner: saved?.limits, catalog })
  }
  // A deployment model has no saved record; its Owner limits are a Server setting for that model.
  const setting = await deploymentProviderSetting(env as L4Env)
  const owner = setting.limits?.model === reference ? setting.limits : undefined
  return resolveModelLimits({ owner, catalog: await deploymentCatalogLimits(env, reference) })
}

export async function agentModelLimits(env: Pick<L4Env, 'DB' | 'AI_BASE_URL'>, reference: string): Promise<AgentModelLimits> {
  const { contextWindow, maxOutputTokens } = await agentModelLimitDetails(env, reference)
  return { contextWindow, maxOutputTokens }
}

/**
 * Pi's compaction thresholds for a window. Its defaults suit a large window; a small one keeps the
 * same shape so the answer allowance and the verbatim tail never fill the window between them.
 */
export function agentCompaction(limits: AgentModelLimits) {
  return {
    reserveTokens: Math.min(Math.max(16_384, limits.maxOutputTokens), Math.floor(limits.contextWindow / 4)),
    keepRecentTokens: Math.min(20_000, Math.floor(limits.contextWindow / 5)),
    backgroundTokens: Math.min(32_768, Math.floor(limits.contextWindow / 8)),
  }
}
