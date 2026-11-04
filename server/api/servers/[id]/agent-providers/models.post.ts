import { z } from 'zod'
import { agentProviderIds } from '../../../../../shared/agent-providers'
import { loadAgentProvider, agentProviderScope } from '../../../../utils/agent-providers'
import { chatGPTAccessToken } from '../../../../utils/agent-chatgpt'
import { decryptSecret } from '../../../../../shared/encrypted-secret'
import { discoverAgentModels } from '../../../../utils/agent-provider-models'
import { providerManager } from '../../../../utils/agent-provider-access'
import { cf, fail } from '../../../../utils/cf'
import { parseBody } from '../../../../utils/validate'
export default defineEventHandler(async event => {
  const manager = await providerManager(event), actor = manager.actor
  const body = parseBody(z.object({ kind: z.enum(agentProviderIds), connectionId: z.string().max(64).optional(), apiKey: z.string().max(4000).optional() }), await readBody(event))
  const { env } = cf(event)
  const saved = body.connectionId ? await loadAgentProvider(env, body.connectionId) : null
  if (saved && saved.kind !== body.kind) fail(400, 'invalid_provider', 'Provider type does not match')
  manager.require(body.kind, saved)
  let key = body.apiKey
  if (body.kind === 'chatgpt') key = await chatGPTAccessToken(env, body.connectionId ?? '', actor.user.id)
  else if (!key && saved?.secret && env.AUTH_SECRET) key = await decryptSecret(env.AUTH_SECRET, agentProviderScope(body.connectionId!), saved.secret)
  setHeader(event, 'Cache-Control', 'no-store')
  return { models: await discoverAgentModels(body.kind, key) }
})
