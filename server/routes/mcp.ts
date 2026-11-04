import { toWebRequest } from 'h3'
import { cf } from '../utils/cf'
import { authenticateMcpRequest } from '../utils/mcp-access'
import { serveMcpRequest } from '../utils/mcp-server'
import { mcpOrigin } from '../utils/mcp-consent'
import { requireRateLimit } from '../utils/rate-limit'
import { loadSpaceBoundary } from '../utils/space-access'
import { SPACE_HEADER } from '../../shared/spaces'

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

  // A token reaching several Spaces can name one for this request, and must to create anything.
  const requested = getHeader(event, SPACE_HEADER)?.trim()
  if (requested && principal.authorization.spaces?.ids.includes(requested)) {
    principal.authorization.spaces = await loadSpaceBoundary(env, principal.userId, { delegatedBy: principal.delegatedBy, scope: requested })
  }
  // Tool calls bypass the API's route gate; their Space boundary travels in `principal`, this limit here.
  await requireRateLimit(event, [{ key: `mcp:${principal.tokenId}`, limit: 600, windowMs: 60_000 }], 'Too many requests. Try again in a moment.')
  return serveMcpRequest(request, { env, principal, schedule: waitUntil, origin })
})
