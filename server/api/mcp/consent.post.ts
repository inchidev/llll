import { z } from 'zod'
import { getServerId } from '../../../shared/server-id'
import { MCP_SCOPES } from '../../../shared/mcp'
import { cf, fail } from '../../utils/cf'
import { requireMember } from '../../utils/guards'
import { mcpAuthFromEvent } from '../../utils/better-auth'
import { mcpOrigin, readMcpConsent } from '../../utils/mcp-consent'
import { createMcpConnection } from '../../utils/mcp-oauth'
import { writeAudit } from '../../utils/messages'
import { parseBody } from '../../utils/validate'

const bodySchema = z.object({
  oauth_query: z.string().max(16_384),
  accept: z.boolean(),
  subjectId: z.string().optional(),
  scopes: z.array(z.enum(MCP_SCOPES)).max(MCP_SCOPES.length).optional(),
})

export default defineEventHandler(async (event) => {
  setHeader(event, 'Cache-Control', 'no-store')
  // Consent always comes from this Server's own browser UI, including in native-client flows.
  if (getHeader(event, 'origin') !== mcpOrigin(event)) fail(403, 'csrf', 'Open the connection page on this Server')
  const { env } = cf(event)
  const serverId = await getServerId(env.DB)
  const actor = await requireMember(event, serverId)
  const body = parseBody(bodySchema, await readBody(event))
  const consent = await readMcpConsent(event, body.oauth_query, actor.user.id)
  let connectionId: string | undefined
  if (body.accept) {
    const scopes = [...new Set(body.scopes ?? [])]
    if (!scopes.length || scopes.some(scope => !consent.scopes.includes(scope))) fail(400, 'invalid_scope', 'Choose requested permissions')
    connectionId = await createMcpConnection(env, {
      createdBy: actor.user.id, subjectId: body.subjectId || actor.user.id,
      clientId: consent.clientId, resource: `${mcpOrigin(event)}/mcp`, scopes,
    })
  }
  try {
    const auth = await mcpAuthFromEvent(event, connectionId)
    // The provider resumes authorization using ctx.request. Use its HTTP handler
    // so that continuation has a real request as well as the local session.
    const headers = new Headers(event.headers)
    headers.set('Content-Type', 'application/json')
    headers.set('Accept', 'application/json')
    const response = await auth.handler(new Request(`${mcpOrigin(event)}/api/auth/oauth2/consent`, {
      method: 'POST', headers,
      body: JSON.stringify({ accept: body.accept, oauth_query: body.oauth_query,
        scope: [...(body.scopes ?? []), ...(consent.offlineAccess ? ['offline_access'] : [])].join(' ') }),
    }))
    const payload = await response.json() as { url?: string; error_description?: string; message?: string }
    if (!response.ok) fail(response.status, 'oauth_consent_failed', payload.error_description || payload.message || 'MCP authorization could not be completed')
    const result = z.object({ url: z.string().url() }).parse(payload)
    if (connectionId) {
      const callback = new URL(result.url)
      if (!callback.searchParams.has('code') || callback.searchParams.has('error')) throw new Error('MCP authorization could not be completed')
      await writeAudit(env, { serverId, actorId: actor.user.id, action: 'mcp_connection.create', targetType: 'mcp_connection', targetId: connectionId,
        meta: { subjectId: body.subjectId || actor.user.id, clientId: consent.clientId, scopes: body.scopes } })
    }
    return { url: result.url }
  }
  catch (error) {
    if (connectionId) await env.DB.prepare('UPDATE mcp_oauth_connections SET revoked_at = ? WHERE id = ?').bind(new Date().toISOString(), connectionId).run()
    throw error
  }
})
