import { embedOrigins } from '../../shared/embed'
import { SERVER_PERMISSIONS_POLICY, strictTransportSecurity } from '../../shared/security-headers'
import { cf, fail, originOk } from '../utils/cf'
import { fetchMetadataExempt, OAUTH_BACKCHANNEL_PATHS, serverContentSecurityPolicy } from '../utils/security-policy'

export default defineEventHandler(async (event) => {
  const path = (event.path || '').split('?')[0]!
  if (path.startsWith('/ws/')) return

  setHeader(event, 'X-Content-Type-Options', 'nosniff')
  setHeader(event, 'Referrer-Policy', 'strict-origin-when-cross-origin')
  setHeader(event, 'Permissions-Policy', SERVER_PERMISSIONS_POLICY)
  // Operator-owned origins: no includeSubDomains, so a Server on an apex name
  // never forces HTTPS onto the operator's unrelated subdomains.
  const hsts = strictTransportSecurity(getRequestURL(event), getHeader(event, 'x-forwarded-proto'), false)
  if (hsts) setHeader(event, 'Strict-Transport-Security', hsts)
  let configured = ''
  try { configured = cf(event).env.EMBED_ORIGINS || '' } catch { /* Prerender has no runtime bindings. */ }
  const allowed = embedOrigins(configured)
  const ancestors = path === '/mcp/authorize' ? "'none'" : allowed.length ? "'self' " + allowed.join(' ') : "'none'"
  setHeader(event, 'Content-Security-Policy', serverContentSecurityPolicy(ancestors))

  const oauthBackchannel = OAUTH_BACKCHANNEL_PATHS.has(path)
  if (oauthBackchannel) {
    setHeader(event, 'Access-Control-Allow-Origin', '*')
    setHeader(event, 'Cache-Control', 'no-store')
    if (event.method === 'OPTIONS') {
      setHeader(event, 'Access-Control-Allow-Methods', 'POST, OPTIONS')
      setHeader(event, 'Access-Control-Allow-Headers', 'Content-Type, Authorization')
      setResponseStatus(event, 204)
      return ''
    }
    // Cross-origin token clients (browser MCP clients) are authenticated by
    // client credentials/PKCE, so the Origin check does not apply here.
    return
  }
  const allowMissingFetchMetadata = fetchMetadataExempt(path, getHeader(event, 'authorization'))
  if (!await originOk(event, { allowMissingFetchMetadata })) {
    fail(403, 'csrf', 'Origin mismatch')
  }
})
