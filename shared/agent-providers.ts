import { z } from 'zod'

export const agentProviderIds = ['openrouter', 'anthropic', 'chatgpt'] as const
export type AgentProviderId = typeof agentProviderIds[number]
export const providerNames: Record<AgentProviderId, string> = { openrouter: 'OpenRouter', anthropic: 'Claude', chatgpt: 'ChatGPT / Codex' }
export const agentConnectionId = z.string().regex(/^[a-z0-9-]{1,64}$/u)
export const agentModelSchema = z.object({ id: z.string().trim().min(1).max(160), label: z.string().max(200).optional(), api: z.enum(['chat', 'responses', 'anthropic']).default('chat') })
export const agentProviderSchema = z.object({
  kind: z.enum(agentProviderIds).optional(), name: z.string().trim().min(1).max(80).optional(),
  enabled: z.boolean(), webSearch: z.boolean().default(false),
  apiKey: z.string().trim().min(1).max(4000).optional(), models: z.array(agentModelSchema).max(200),
})
export type AgentProviderModel = z.infer<typeof agentModelSchema>
export type AgentProviderDTO = { id: string; kind: AgentProviderId; name: string; configured: boolean; enabled: boolean; models: AgentProviderModel[]; subscription: boolean; webSearch: boolean; keyPreview?: string; account?: string; personal?: boolean; connectedAt?: string }
export type AgentModelOption = { value: string; label: string; provider: string }
export type AgentProviderCatalog = { providers: AgentProviderDTO[]; models: AgentModelOption[]; defaultModel: string | null; canImportOpenRouter: boolean }
export function agentModelRef(provider: string, model: string): string { return `l4:${provider}:${model}` }
export function parseAgentModelRef(value: string): { provider: string; model: string } | null {
  const match = /^l4:([a-z0-9-]{1,64}):(.+)$/u.exec(value)
  return match ? { provider: match[1]!, model: match[2]! } : null
}
export function agentModelLabel(model: AgentModelOption) { return `${model.provider} / ${model.label}` }
