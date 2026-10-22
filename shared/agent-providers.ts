import { z } from 'zod'

export const agentProviderIds = ['openrouter', 'opencode', 'opencode-go', 'anthropic'] as const
export const agentModelSchema = z.object({
  id: z.string().trim().min(1).max(160),
  api: z.enum(['chat', 'responses', 'anthropic']).default('chat'),
})
export const agentProviderSchema = z.object({
  enabled: z.boolean(),
  webSearch: z.boolean().default(false),
  apiKey: z.string().trim().min(1).max(4000).optional(),
  models: z.array(agentModelSchema).min(1).max(30),
})
export type AgentProviderId = typeof agentProviderIds[number]
export type AgentProviderModel = z.infer<typeof agentModelSchema>
export type AgentProviderDTO = { id: AgentProviderId; name: string; configured: boolean; enabled: boolean; models: AgentProviderModel[]; subscription: boolean; webSearch: boolean }
export type AgentModelOption = { value: string; label: string; provider: string }
export type AgentProviderCatalog = { providers: AgentProviderDTO[]; models: AgentModelOption[]; defaultModel: string | null; canImportOpenRouter: boolean }
export const providerNames: Record<AgentProviderId, string> = { openrouter: 'OpenRouter', opencode: 'OpenCode', 'opencode-go': 'OpenCode Go', anthropic: 'Claude' }
// Qualified model references are persisted in the existing Run model snapshot.
export function agentModelRef(provider: AgentProviderId, model: string): string { return `l4:${provider}:${model}` }
export function parseAgentModelRef(value: string): { provider: AgentProviderId; model: string } | null {
  const match = /^l4:([^:]+):(.+)$/u.exec(value)
  return match && agentProviderIds.includes(match[1] as AgentProviderId) ? { provider: match[1] as AgentProviderId, model: match[2]! } : null
}
