import { z } from 'zod'

export const agentProviderIds = ['openrouter', 'anthropic', 'chatgpt'] as const
export type AgentProviderId = typeof agentProviderIds[number]
export const providerNames: Record<AgentProviderId, string> = { openrouter: 'OpenRouter', anthropic: 'Claude', chatgpt: 'ChatGPT / Codex' }
export const agentModelInputs = ['text', 'image', 'audio', 'video', 'file'] as const
export type AgentModelInput = typeof agentModelInputs[number]
export const agentEfforts = ['auto', 'low', 'medium', 'high'] as const
export type AgentEffort = typeof agentEfforts[number]
export const agentConnectionId = z.string().regex(/^[a-z0-9-]{1,64}$/u)
export const agentModelSchema = z.object({ id: z.string().trim().min(1).max(160), label: z.string().max(200).optional(), tools: z.boolean().optional(),
  /** Input modalities reported by the provider catalog; absent when it does not report them. */
  inputs: z.array(z.enum(agentModelInputs)).max(agentModelInputs.length).optional(), reasoning: z.boolean().optional(), api: z.enum(['chat', 'responses', 'anthropic']).default('chat') })
export const agentProviderSchema = z.object({
  // An empty connection name falls back to the provider name; the field shows that name rather than a placeholder.
  kind: z.enum(agentProviderIds).optional(), name: z.string().trim().max(80, 'Connection name must be 80 characters or fewer').optional(),
  enabled: z.boolean(), webSearch: z.boolean().default(false),
  /** ChatGPT only: the connecting member shares their plan with everyone on this Server. */
  shared: z.boolean().optional(),
  apiKey: z.string().trim().min(1).max(4000).optional(), models: z.array(agentModelSchema).max(200),
})
export type AgentProviderModel = z.infer<typeof agentModelSchema>
export type AgentProviderDTO = { id: string; kind: AgentProviderId; name: string; configured: boolean; enabled: boolean; models: AgentProviderModel[]; subscription: boolean; webSearch: boolean; keyPreview?: string; account?: string; personal?: boolean; connectedAt?: string; shared?: boolean; mine?: boolean }
export type AgentModelOption = { value: string; label: string; provider: string; tools?: boolean; inputs?: AgentModelInput[]; reasoning?: boolean }
export type AgentProviderCatalog = { providers: AgentProviderDTO[]; models: AgentModelOption[]; defaultModel: string | null; canImportOpenRouter: boolean; deploymentProvider?: string | null }
export function agentModelRef(provider: string, model: string): string { return `l4:${provider}:${model}` }
export function parseAgentModelRef(value: string): { provider: string; model: string } | null {
  const match = /^l4:([a-z0-9-]{1,64}):(.+)$/u.exec(value)
  return match ? { provider: match[1]!, model: match[2]! } : null
}
export function agentModelLabel(model: AgentModelOption) { return `${model.provider} / ${model.label}` }
