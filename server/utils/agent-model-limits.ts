import { parseAgentModelRef, type AgentProviderId } from '../../shared/agent-providers'
import { loadAgentProvider } from './agent-providers'
import type { L4Env } from '../../workers/env'

/** What Pi and the model gateway are told about a Run's model. */
export type AgentModelLimits = { contextWindow: number; maxOutputTokens: number }

/**
 * Pi sends the whole retained context with every call, so a million-token window would spend a
 * Run's token budget in a few calls. Compaction keeps a long Run inside this ceiling instead.
 */
export const agentContextCeiling = 200_000
const outputCeiling = 32_000
/** An unknown model. Pi compacts when a provider reports an overflow, so a generous guess recovers. */
export const unknownModelLimits: AgentModelLimits = { contextWindow: 128_000, maxOutputTokens: 8_192 }

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

async function catalogModel(kind: CatalogKind | undefined, id: string): Promise<CatalogModel | undefined> {
  if (!kind) return undefined
  const catalog = await catalogs[kind]()
  // Anthropic's API lists dated snapshots of the aliases the catalog names.
  return catalog[id] ?? catalog[id.replace(/-\d{8}$/u, '')]
}

const positive = (value: number | undefined) => typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined

/**
 * A model's real limits: what its provider reported when it was saved, then Pi's catalog, then a
 * generous default. The window is capped at the ceiling above, and the answer at a quarter of it.
 */
export async function agentModelLimits(env: Pick<L4Env, 'DB' | 'AI_BASE_URL'>, reference: string): Promise<AgentModelLimits> {
  const parsed = parseAgentModelRef(reference)
  let saved: { contextWindow?: number; maxOutputTokens?: number } | undefined
  let catalog: CatalogModel | undefined
  if (parsed) {
    const provider = await loadAgentProvider(env as L4Env, parsed.provider)
    saved = provider?.models.find(model => model.id === parsed.model)
    if (!positive(saved?.contextWindow) || !positive(saved?.maxOutputTokens)) catalog = await catalogModel(provider?.kind, parsed.model)
  } else {
    // A deployment model: Workers AI, or an OpenAI-compatible endpoint that may be OpenRouter.
    const openRouter = env.AI_BASE_URL?.trim().replace(/\/+$/u, '') === 'https://openrouter.ai/api/v1'
    catalog = await catalogModel(reference.startsWith('@cf/') ? 'workers-ai' : openRouter ? 'openrouter' : undefined, reference)
  }
  const contextWindow = Math.min(positive(saved?.contextWindow) ?? positive(catalog?.contextWindow) ?? unknownModelLimits.contextWindow, agentContextCeiling)
  const output = positive(saved?.maxOutputTokens) ?? positive(catalog?.maxTokens) ?? unknownModelLimits.maxOutputTokens
  return { contextWindow, maxOutputTokens: Math.max(1024, Math.min(output, outputCeiling, Math.floor(contextWindow / 4))) }
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
