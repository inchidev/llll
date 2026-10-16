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
