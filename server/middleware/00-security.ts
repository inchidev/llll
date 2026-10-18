import { embedOrigins } from '../../shared/embed'
import { cf, fail, originOk  } from '../utils/cf'

export default defineEventHandler((event) => {
  const path = event.path || ''
  if (path.startsWith('/ws/')) return

  setHeader(event, 'X-Content-Type-Options', 'nosniff')
  setHeader(event, 'Referrer-Policy', 'strict-origin-when-cross-origin')
  let configured = ''
  try { configured = cf(event).env.EMBED_ORIGINS || '' } catch { /* Prerender has no runtime bindings. */ }
  const allowed = embedOrigins(configured)
  const ancestors = allowed.length ? "'self' " + allowed.join(' ') : "'none'"
  setHeader(
    event,
    'Content-Security-Policy',
    `default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' https: wss: ws:; script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com; style-src 'self' 'unsafe-inline'; font-src 'self' data:; frame-src https://challenges.cloudflare.com; frame-ancestors ${ancestors}; base-uri 'self'`,
  )

  if (!originOk(event)) {
    fail(403, 'csrf', 'Origin mismatch')
  }
})
