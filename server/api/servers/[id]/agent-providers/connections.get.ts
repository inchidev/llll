import { z } from 'zod'
import { agentProviderPage } from '../../../../utils/agent-providers'
import { providerManager } from '../../../../utils/agent-provider-access'
import { cf } from '../../../../utils/cf'
import { parseBody } from '../../../../utils/validate'
export default defineEventHandler(async event => {
  const { actor, owner } = await providerManager(event)
  const { search, page } = parseBody(z.object({ search: z.string().max(160).default(''), page: z.coerce.number().int().min(1).max(1000000).default(1) }), getQuery(event))
  setHeader(event, 'Cache-Control', 'no-store')
  const result = await agentProviderPage(cf(event).env, actor.user.id, search, page)
  if (owner) return result
  // Members see only ChatGPT connections they may use, and another member's account stays private.
  const providers = result.providers.filter(provider => provider.kind === 'chatgpt').map(provider => provider.mine ? provider : { ...provider, account: undefined })
  return { providers, total: providers.length }
})
