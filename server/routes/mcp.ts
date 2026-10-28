import { toWebRequest } from 'h3'
import { cf } from '../utils/cf'
import { authenticateMcpRequest } from '../utils/mcp-access'
import { serveMcpRequest } from '../utils/mcp-server'
import { mcpOrigin } from '../utils/mcp-consent'

export default defineEventHandler(async (event) => {
  const request = toWebRequest(event)
  const { env, waitUntil } = cf(event)
  const origin = await mcpOrigin(event)
  const principal = await authenticateMcpRequest(env, request, waitUntil, `${origin}/mcp`)
  if (!principal) {
    return new Response(JSON.stringify({ error: 'invalid_token' }), {
      status: 401,
      headers: {
        'Cache-Control': 'no-store',
        'Content-Type': 'application/json',
        'WWW-Authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
      },
    })
  }

  return serveMcpRequest(request, { env, principal, schedule: waitUntil, origin })
})
