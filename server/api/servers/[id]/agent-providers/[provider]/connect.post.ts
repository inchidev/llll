import { z } from 'zod'
import { beginChatGPT } from '../../../../../utils/agent-chatgpt'
import { providerManager } from '../../../../../utils/agent-provider-access'
import { cf, fail } from '../../../../../utils/cf'
import { parseBody } from '../../../../../utils/validate'
export default defineEventHandler(async event => {
  // beginChatGPT also requires a ChatGPT connection that is new or this member's own.
  const { actor } = await providerManager(event)
  const { local } = parseBody(z.object({ local: z.boolean() }), await readBody(event))
  const url = getRequestURL(event)
  if (local && (url.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(url.hostname))) fail(400, 'loopback_only', 'Use the local sign-in helper for a remote Server')
  setHeader(event, 'Cache-Control', 'no-store')
  return beginChatGPT(cf(event).env, getRouterParam(event, 'provider')!, actor.user.id, url.origin, local)
})
