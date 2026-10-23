import { z } from 'zod'
import type { AgentProviderId, AgentProviderModel } from '../../shared/agent-providers'
import { fail } from './cf'
import { readLimitedStream } from '../../workers/inbound-email-signature'

/** Known origins only: a submitted provider never supplies a URL for credential-bearing requests. */
export async function discoverAgentModels(kind: AgentProviderId, apiKey?: string): Promise<AgentProviderModel[]> {
  const url = kind === 'openrouter' ? 'https://openrouter.ai/api/v1/models' : kind === 'anthropic' ? 'https://api.anthropic.com/v1/models?limit=1000' : kind === 'chatgpt' ? 'https://api.openai.com/v1/models' : `https://opencode.ai/inference/${kind === 'opencode-go' ? 'go/' : ''}v1/models`
  const headers: Record<string, string> = kind === 'anthropic' ? { 'x-api-key': apiKey ?? '', 'anthropic-version': '2023-06-01' } : apiKey ? { Authorization: `Bearer ${apiKey}` } : {}
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(15000), redirect: 'error' })
  const body = await readLimitedStream(response.body, 5000000)
  if (!response.ok || !body.ok) fail(502, 'catalog_failed', 'Could not load models. Check the connection and try again.')
  const raw = z.object({ data: z.array(z.record(z.string(), z.unknown())).optional(), models: z.array(z.record(z.string(), z.unknown())).optional() }).parse(JSON.parse(new TextDecoder().decode(body.bytes)))
  return (raw.data ?? raw.models ?? []).flatMap(row => {
    const id = kind === 'chatgpt' ? row.slug : row.id
    if (typeof id !== 'string' || !id || id.length > 160 || (kind === 'chatgpt' && row.visibility !== 'list')) return []
    const api = kind === 'anthropic' ? 'anthropic' : kind === 'chatgpt' ? 'responses' : kind.startsWith('opencode') ? (/^(claude|qwen)/u.test(id) ? 'anthropic' : /^gpt-/u.test(id) ? 'responses' : /^gemini/u.test(id) ? null : 'chat') : 'chat'
    if (!api) return [] // Gemini transport is not supported by this runtime.
    const label = row.display_name ?? row.name ?? id
    return [{ id, label: typeof label === 'string' ? label.slice(0, 200) : id, api }]
  })
}
