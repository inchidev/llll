import { completeChatGPT } from '../../utils/agent-chatgpt'
import { cf } from '../../utils/cf'
export default defineEventHandler(async event => {
  setHeader(event, 'Cache-Control', 'no-store')
  setHeader(event, 'Referrer-Policy', 'no-referrer')
  const result = await completeChatGPT(cf(event).env, getRequestURL(event))
  setHeader(event, 'Content-Type', 'text/html; charset=utf-8')
  // No code or token is reflected into HTML. The original settings page polls its connection.
  return `<!doctype html><html><meta name="viewport" content="width=device-width"><title>ChatGPT connected</title><body><h1>ChatGPT connected</h1><p>Return to L4 settings. You can close this tab.</p><a href="${result.returnOrigin.replaceAll('&', '&amp;').replaceAll('"', '&quot;')}">Return to L4</a><script>history.replaceState(null,'','/api/agent-auth/callback');</script></body></html>`
})
