import type { H3Event } from 'h3'
import { verifyOAuthQueryParams } from '@better-auth/oauth-provider'
import type { McpConsentDTO } from '../../shared/mcp'
import { MCP_SCOPES } from '../../shared/mcp'
import { cf, fail } from './cf'
import { authSecret } from './auth-config'
import { resolveAuthBaseURL } from './better-auth'
import { mcpConsentSubjects } from './mcp-oauth'

export function mcpOrigin(event: H3Event) {
  return resolveAuthBaseURL(cf(event).env.PUBLIC_ORIGIN, getRequestURL(event).origin)
}

export async function readMcpConsent(event: H3Event, query: string, actorId: string): Promise<McpConsentDTO> {
  const { env } = cf(event)
  if (!query || query.length > 16_384 || !await verifyOAuthQueryParams(query, authSecret(env, mcpOrigin(event)))) {
    fail(400, 'invalid_request', 'This connection request is invalid or expired. Start again from your MCP client.')
  }
  const params = new URLSearchParams(query)
  const resources = params.getAll('resource')
  if (resources.length !== 1 || resources[0] !== `${mcpOrigin(event)}/mcp`) {
    fail(400, 'invalid_target', 'This request must target this Server’s MCP endpoint')
  }
  const clientId = params.get('client_id') || ''
  const client = await env.DB.prepare('SELECT name, redirect_uris as redirects FROM auth_oauth_client WHERE client_id = ? AND COALESCE(disabled, 0) = 0')
    .bind(clientId).first<{ name: string | null; redirects: string }>()
  if (!client) fail(400, 'invalid_client', 'This MCP client is unavailable')
  const requested = (params.get('scope') || '').split(' ').filter(Boolean)
  if (requested.some(scope => scope !== 'offline_access' && !MCP_SCOPES.some(value => value === scope))) {
    fail(400, 'invalid_scope', 'Unknown MCP permissions requested')
  }
  const scopes = MCP_SCOPES.filter(scope => requested.includes(scope))
  if (!scopes.length) fail(400, 'invalid_scope', 'Choose at least one MCP permission')
  return {
    clientId, clientName: client.name || 'MCP client', redirectUri: params.get('redirect_uri') || '', scopes,
    offlineAccess: requested.includes('offline_access'),
    subjects: (await mcpConsentSubjects(env, actorId)).map(({ permissions: _permissions, ...subject }) => subject),
  }
}
