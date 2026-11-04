import { z } from 'zod'
import { completeChatGPT } from '../../utils/agent-chatgpt'
import { cf } from '../../utils/cf'
import { parseBody } from '../../utils/validate'
/** The pasted loopback address is checked by one-time state + PKCE, never a browser session cookie. */
export default defineEventHandler(async event => {
  const { callbackUrl } = parseBody(z.object({ callbackUrl: z.string().url().max(12000) }), await readBody(event))
  setHeader(event, 'Cache-Control', 'no-store')
  await completeChatGPT(cf(event).env, new URL(callbackUrl))
  return { connected: true }
})
