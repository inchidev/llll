import { APIError, createAuthMiddleware } from 'better-auth/api'
import { oauthProvider } from '@better-auth/oauth-provider'
import type { L4Env } from '../../workers/env'
import { MCP_SCOPES } from '../../shared/mcp'
import { hashMcpToken, requireMcpConnection, requireMcpRefreshGrant } from './mcp-oauth'

/** The selected connection is request-local and supplied only by our consent API. */
export function mcpOAuthProvider(env: L4Env, origin: string, connectionId?: string) {
  const resource = `${origin}/mcp`
  const provider = oauthProvider({
    disableJwtPlugin: true,
    loginPage: '/mcp/authorize',
    consentPage: '/mcp/authorize',
    scopes: [...MCP_SCOPES, 'offline_access'],
    advertisedMetadata: { scopes_supported: [...MCP_SCOPES, 'offline_access'] },
    grantTypes: ['authorization_code', 'refresh_token'],
    allowDynamicClientRegistration: true,
    allowUnauthenticatedClientRegistration: true,
    clientRegistrationDefaultApplicationType: 'infer',
    clientRegistrationRequirePKCE: true,
    clientRegistrationDefaultResources: [resource],
    resources: [{ identifier: resource, name: 'L4 MCP', allowedScopes: [...MCP_SCOPES, 'offline_access'] }],
    accessTokenExpiresIn: 60 * 15,
    refreshTokenExpiresIn: 60 * 60 * 24 * 30,
    codeExpiresIn: 60 * 10,
    storeTokens: { hash: hashMcpToken },
    prefix: { opaqueAccessToken: 'l4_at_', refreshToken: 'l4_rt_', clientSecret: 'l4_cs_' },
    // DCR may identify a client; only a human consent grants access to L4 data.
    clientPrivileges: async () => false,
    resourcePrivileges: async () => false,
    postLogin: {
      page: '/mcp/authorize',
      shouldRedirect: async () => !connectionId,
      consentReferenceId: async ({ user }) => {
        if (!connectionId || !user) throw new APIError('FORBIDDEN', { message: 'Choose a member through the MCP consent page' })
        await requireMcpConnection(env, connectionId, user.id, resource)
        return connectionId
      },
    },
    // Runs before opaque token issuance. JWT claim callbacks do not run for opaque tokens.
    customTokenResponseFields: async ({ user, verificationValue, scopes, grantType }) => {
      if (grantType !== 'authorization_code') return {}
      const referenceId = verificationValue?.referenceId
      const requestedResource = verificationValue?.query.resource
      const resources = Array.isArray(requestedResource) ? requestedResource : [requestedResource]
      if (!user || !referenceId || resources.length !== 1 || resources[0] !== resource) {
        throw new APIError('BAD_REQUEST', { error: 'invalid_grant', error_description: 'An MCP connection and its exact resource are required' })
      }
      const connection = await requireMcpConnection(env, referenceId, user.id, resource)
      if (scopes.some(scope => scope !== 'offline_access' && !new Set<string>(connection.scopes).has(scope))) {
        throw new APIError('BAD_REQUEST', { error: 'invalid_scope', error_description: 'Scope exceeds the approved connection' })
      }
      return {}
    },
  })
  return {
    ...provider,
    hooks: {
      ...provider.hooks,
      before: [
        ...(provider.hooks?.before ?? []),
        {
          matcher: (context: { path?: string }) => context.path === '/oauth2/token',
          handler: createAuthMiddleware(async (ctx) => {
            if (ctx.body?.grant_type === 'refresh_token' && typeof ctx.body.refresh_token === 'string') {
              await requireMcpRefreshGrant(env, ctx.body.refresh_token, resource)
            }
          }),
        },
      ],
    },
  }
}
