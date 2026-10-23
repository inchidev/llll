import { createError } from 'h3'
import { chatGPTAccessToken } from '../server/utils/agent-chatgpt'
import { chatGPTFetch } from '../server/utils/chatgpt-transport'
import { createAnthropic } from '@ai-sdk/anthropic'
import { agentProviderCatalog, catalogAgentModel, resolveSavedAgentModel } from '../server/utils/agent-providers'
import { createOpenAI } from '@ai-sdk/openai'
import type { LanguageModel } from 'ai'
import { aiProvider, resolveAgentModelId, type L4Env } from './env'
import { workersAiRestModel } from './workers-ai-rest-model'

/**
 * Workers AI keeps the model id string for the Server gateway’s `AI` binding.
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
export async function modelForRun(env: L4Env, reference: string, _sessionId: string, actorId?: string): Promise<LanguageModel | string> {
  if (!reference.startsWith('l4:')) {
    const resolved = catalogAgentModel(env, reference, await agentProviderCatalog(env, { actorId }))
    if (!resolved) throw createError({ statusCode: 409, statusMessage: 'The selected model is no longer available' })
    reference = resolved
  }
  const saved = await resolveSavedAgentModel(env, reference, actorId)
  if (!saved) {
    if (reference.startsWith('@cf/') && aiProvider(env) === 'openai-compatible') throw createError({ statusCode: 409, statusMessage: 'The selected Workers AI model is unavailable under the current provider configuration' })
    return modelForAgent(env, reference)
  }
  if (saved.id === 'chatgpt') return createOpenAI({ apiKey: await chatGPTAccessToken(env, saved.connectionId, actorId!), fetch: chatGPTFetch }).responses(saved.model.id)
  if (saved.id === 'anthropic') return createAnthropic({ apiKey: saved.apiKey })(saved.model.id)
  return createOpenAI({ baseURL: 'https://openrouter.ai/api/v1', apiKey: saved.apiKey }).chat(saved.model.id)
}
