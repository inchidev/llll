import { z } from 'zod'
import { agentModelLimitsInput } from '../../shared/agent-providers'
import { readServerSetting, writeServerSetting } from '../../shared/server-settings'
import { workersAiModels } from '../../shared/workers-ai-models'
import { aiProvider, resolveAgentModelId, type L4Env } from '../../workers/env'

/**
 * The model provider that comes with the deployment (Workers AI through the
 * Server's AI binding or Cloudflare REST, or an operator's OpenAI-compatible
 * endpoint). The binding itself cannot be removed from Settings, so the Owner
 * turns it off or narrows which Workers AI models agents see.
 */
const KEY = 'agents.deployment'
// An OpenAI-compatible deployment model has no saved record, so the limits its Owner sets live here, for that model only.
const deploymentLimits = agentModelLimitsInput.extend({ model: z.string().min(1).max(200) }).strict()
const settingSchema = z.object({ enabled: z.boolean(), models: z.array(z.string().max(200)).max(200).nullable(), limits: deploymentLimits.nullable().optional() })
export type DeploymentProviderSetting = z.infer<typeof settingSchema>

export async function deploymentProviderSetting(env: L4Env): Promise<DeploymentProviderSetting> {
  const value = await readServerSetting(env.DB, KEY).catch(() => null)
  const parsed = value ? settingSchema.safeParse(JSON.parse(value)) : null
  return parsed?.success ? parsed.data : { enabled: true, models: null }
}
/** Workers AI models agents may see; null when the deployment provider is off or absent. */
export function allowedWorkersAiModels(env: L4Env, setting: DeploymentProviderSetting) {
  if (!setting.enabled || !aiProvider(env) || aiProvider(env) === 'openai-compatible') return null
  return workersAiModels.filter(model => !setting.models || setting.models.includes(model.id))
}
export function deploymentProviderName(env: L4Env) {
  const provider = aiProvider(env)
  return provider ? provider === 'openai-compatible' ? 'Deployment' : 'Workers AI' : null
}
export async function deploymentProviderState(env: L4Env) {
  const setting = await deploymentProviderSetting(env)
  const name = deploymentProviderName(env)
  const deploymentModel = name ? resolveAgentModelId(env) : null
  // The deployment's own endpoint reports no limits; the Owner may set them. Settings resolves what a Run uses
  // from these with the same rule as the Run (shared/agent-model-limits.ts).
  let limits = null
  if (name === 'Deployment' && deploymentModel) {
    const { deploymentCatalogLimits } = await import('./agent-model-limits')
    const owner = setting.limits?.model === deploymentModel ? { contextWindow: setting.limits.contextWindow, maxOutputTokens: setting.limits.maxOutputTokens } : null
    limits = { owner, catalog: await deploymentCatalogLimits(env, deploymentModel) ?? null }
  }
  return {
    available: Boolean(name), name, enabled: setting.enabled,
    models: name === 'Workers AI' ? workersAiModels.map(model => ({ ...model, selected: !setting.models || setting.models.includes(model.id) })) : [],
    deploymentModel, limits,
  }
}
export async function saveDeploymentProvider(env: L4Env, input: unknown) {
  const value = settingSchema.parse(input)
  const known = new Set(workersAiModels.map(model => model.id))
  // A save that does not name limits keeps the ones set before.
  const limits = value.limits === undefined ? (await deploymentProviderSetting(env)).limits ?? null : value.limits
  await writeServerSetting(env.DB, KEY, JSON.stringify({ enabled: value.enabled, models: value.models?.filter(id => known.has(id)) ?? null, limits }))
}
