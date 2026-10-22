import { createAnthropic } from '@ai-sdk/anthropic'
import { resolveSavedAgentModel } from '../server/utils/agent-providers'
import { createOpenAI } from '@ai-sdk/openai'
import type { LanguageModel } from 'ai'
import { aiProvider, resolveAgentModelId, type L4Env } from './env'
import { workersAiRestModel } from './workers-ai-rest-model'

/**
 * Workers AI keeps the model id string so Think resolves it through the `AI` binding.
 * REST and OpenAI-compatible endpoints must be a LanguageModel: a string would be sent to `env.AI`.
 */
export function modelForAgent(env: L4Env, profileModel?: string | null): LanguageModel | string {
  const modelId = resolveAgentModelId(env, profileModel)
  const provider = aiProvider(env)
  if (provider === 'workers-ai-rest') return workersAiRestModel(env, modelId)
  if (provider !== 'openai-compatible') return modelId
  const baseURL = env.AI_BASE_URL!.trim().replace(/\/+$/, '')
  return createOpenAI({
    baseURL,
    apiKey: env.AI_API_KEY!.trim(),
  }).chat(modelId)
}

/** Provider credentials stay on the Server; compute receives only a Run capability. */
export async function modelForRun(env: L4Env, reference: string, sessionId: string): Promise<LanguageModel | string> {
  const saved = await resolveSavedAgentModel(env, reference)
  if (!saved) return modelForAgent(env, reference)
  if (saved.id === 'anthropic') return createAnthropic({ apiKey: saved.apiKey })(saved.model.id)
  const headers = { 'x-opencode-session': sessionId }
  // AI SDK adds its own User-Agent after provider headers; identify L4 at the final transport boundary.
  const providerFetch: typeof fetch = (input, init) => {
    const outgoing = new Headers(init?.headers)
    outgoing.set('User-Agent', 'l4/pi')
    outgoing.set('x-opencode-session', sessionId)
    return globalThis.fetch(input, { ...init, headers: outgoing, redirect: 'error' })
  }
  if (saved.id === 'openrouter') return createOpenAI({ baseURL: 'https://openrouter.ai/api/v1', apiKey: saved.apiKey }).chat(saved.model.id)
  const base = saved.id === 'opencode-go' ? 'https://opencode.ai/inference/go' : 'https://opencode.ai/inference'
  if (saved.model.api === 'anthropic') return createAnthropic({ baseURL: `${base}/anthropic/v1`, apiKey: saved.apiKey, fetch: providerFetch, headers: { ...headers, Authorization: `Bearer ${saved.apiKey}` } })(saved.model.id)
  const provider = createOpenAI({ baseURL: `${base}/openai/v1`, apiKey: saved.apiKey, headers, fetch: providerFetch })
  return saved.model.api === 'responses' ? provider.responses(saved.model.id) : provider.chat(saved.model.id)
}
