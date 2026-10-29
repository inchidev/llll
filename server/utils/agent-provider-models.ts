import { z } from 'zod'
import { agentModelInputs, type AgentModelInput, type AgentProviderId, type AgentProviderModel } from '../../shared/agent-providers'
import { fail } from './cf'
import { readLimitedStream } from '../../workers/inbound-email-signature'

/** Known origins only: a submitted provider never supplies a URL for credential-bearing requests. */
export async function discoverAgentModels(kind: AgentProviderId, apiKey?: string): Promise<AgentProviderModel[]> {
  if (!apiKey && kind !== 'openrouter') fail(400, 'key_required', 'Enter an API key before loading models')
  const url = kind === 'openrouter' ? 'https://openrouter.ai/api/v1/models' : kind === 'anthropic' ? 'https://api.anthropic.com/v1/models?limit=1000' : 'https://api.openai.com/v1/models'
  const headers: Record<string, string> = kind === 'anthropic' ? { 'x-api-key': apiKey ?? '', 'anthropic-version': '2023-06-01' } : apiKey ? { Authorization: `Bearer ${apiKey}` } : {}
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(15000), redirect: 'manual' })
  if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); fail(502, 'catalog_redirect', 'The provider returned an unexpected redirect. Check its configuration.') }
  if ([401, 403].includes(response.status)) { await response.body?.cancel(); fail(400, 'provider_auth', 'The provider rejected this API key. Check the key and account access.') }
  const body = await readLimitedStream(response.body, 5000000)
  if (!response.ok || !body.ok) fail(502, 'catalog_failed', 'Could not load models. Check the connection and try again.')
  const raw = z.object({ data: z.array(z.record(z.string(), z.unknown())).optional(), models: z.array(z.record(z.string(), z.unknown())).optional() }).parse(JSON.parse(new TextDecoder().decode(body.bytes)))
  return (raw.data ?? raw.models ?? []).flatMap(row => {
    const id = kind === 'chatgpt' ? row.slug : row.id
    if (typeof id !== 'string' || !id || id.length > 160 || (kind === 'chatgpt' && row.visibility !== 'list')) return []
    const api = kind === 'anthropic' ? 'anthropic' : kind === 'chatgpt' ? 'responses' : 'chat'
    const label = row.display_name ?? row.name ?? id
    return [{ id, label: typeof label === 'string' ? label.slice(0, 200) : id, api, ...capabilities(kind, row) }]
  })
}

/** What a model accepts and whether it reasons, as the provider catalog reports it. */
function capabilities(kind: AgentProviderId, row: Record<string, unknown>): Pick<AgentProviderModel, 'tools' | 'inputs' | 'reasoning'> {
  // Every current Claude and ChatGPT/Codex model reads images; their catalogs do not list modalities.
  if (kind !== 'openrouter') return { inputs: ['text', 'image', ...(kind === 'anthropic' ? ['file' as const] : [])] }
  const parameters = Array.isArray(row.supported_parameters) ? row.supported_parameters : null
  const architecture = row.architecture && typeof row.architecture === 'object' ? row.architecture as Record<string, unknown> : null
  const inputs = Array.isArray(architecture?.input_modalities) ? architecture.input_modalities.filter((value): value is AgentModelInput => agentModelInputs.includes(value as AgentModelInput)) : null
  return { ...(parameters ? { tools: parameters.includes('tools'), reasoning: parameters.includes('reasoning') || parameters.includes('reasoning_effort') } : {}), ...(inputs ? { inputs } : {}) }
}
