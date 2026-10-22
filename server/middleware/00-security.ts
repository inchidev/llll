import { embedOrigins } from '../../shared/embed'
import { cf, fail, originOk  } from '../utils/cf'

export default defineEventHandler(async (event) => {
  const path = (event.path || '').split('?')[0]!
  if (path.startsWith('/ws/')) return

  setHeader(event, 'X-Content-Type-Options', 'nosniff')
  setHeader(event, 'Referrer-Policy', 'strict-origin-when-cross-origin')
  let configured = ''
  try { configured = cf(event).env.EMBED_ORIGINS || '' } catch { /* Prerender has no runtime bindings. */ }
  const allowed = embedOrigins(configured)
  const ancestors = path === '/mcp/authorize' ? "'none'" : allowed.length ? "'self' " + allowed.join(' ') : "'none'"
  setHeader(
    event,
    'Content-Security-Policy',
    `default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' https: wss: ws:; script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com; style-src 'self' 'unsafe-inline'; font-src 'self' data:; frame-src https://challenges.cloudflare.com; frame-ancestors ${ancestors}; base-uri 'self'`,
  )

  // These OAuth backchannels use client authentication/PKCE, never browser cookies.
  const oauthBackchannel = ['/api/auth/oauth2/token', '/api/auth/oauth2/register', '/api/auth/oauth2/revoke', '/api/auth/oauth2/introspect'].includes(path)
  if (oauthBackchannel) {
    setHeader(event, 'Access-Control-Allow-Origin', '*')
    setHeader(event, 'Cache-Control', 'no-store')
    if (event.method === 'OPTIONS') {
      setHeader(event, 'Access-Control-Allow-Methods', 'POST, OPTIONS')
      setHeader(event, 'Access-Control-Allow-Headers', 'Content-Type, Authorization')
      setResponseStatus(event, 204)
      return ''
    }
  }
  if (!oauthBackchannel && !await originOk(event)) {
    fail(403, 'csrf', 'Origin mismatch')
  }
})
