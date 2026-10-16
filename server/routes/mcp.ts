import { createMcpHandler } from 'agents/mcp/server'
import { toWebRequest } from 'h3'
import { cf } from '../utils/cf'
import { authenticateMcpRequest } from '../utils/mcp-access'
import { createL4McpServer } from '../utils/mcp-server'

export default defineEventHandler(async (event) => {
  const request = toWebRequest(event)
  const { env, waitUntil } = cf(event)
  const principal = await authenticateMcpRequest(env, request, waitUntil)
  if (!principal) {
    return new Response(JSON.stringify({ error: 'invalid_token' }), {
      status: 401,
      headers: {
        'Cache-Control': 'no-store',
        'Content-Type': 'application/json',
        'WWW-Authenticate': 'Bearer',
      },
    })
  }

  const hostname = new URL(request.url).hostname
  const handler = createMcpHandler(
    () => createL4McpServer({ env, principal, schedule: waitUntil }),
    {
      route: '/mcp',
      corsOptions: false,
      allowedHostnames: [hostname],
      allowedOriginHostnames: [hostname],
    },
  )
  return handler.fetch(request)
})
