import { safeEmbedPath, embedOrigins, uuidSchema } from '../../../shared/embed'
import { installationAuth } from './auth'
import type { InstallationEnv } from './env'

/** A same-origin POST carries the installation session across an iframe reload.
 * No credential enters the parent shell, a URL, or a shared browser cookie jar.
 */
export async function embedNavigation(request: Request, env: InstallationEnv) {
  if (request.headers.get('origin') !== new URL(env.PUBLIC_ORIGIN).origin) return new Response('Origin mismatch', { status: 403 })
  const length = Number(request.headers.get('content-length') || 0)
  if (length > 8192) return new Response('Request too large', { status: 413 })
  const reader = request.body?.getReader(); const chunks: Uint8Array[] = []; let size = 0
  if (reader) while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 8192) { await reader.cancel(); return new Response('Request too large', { status: 413 }) } chunks.push(value) }
  const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
  const data = new URLSearchParams(new TextDecoder().decode(bytes))
  const parent = data.get('parent') || ''; const serverId = data.get('server') || ''; const path = data.get('path') || '/'; const token = data.get('session') || ''
  if (!embedOrigins(env.EMBED_ORIGINS).includes(parent) || !uuidSchema.safeParse(serverId).success || !safeEmbedPath(path) || token.length > 2000) return new Response('Invalid navigation', { status: 400 })
  const headers = new Headers(request.headers)
  if (token) headers.set('Authorization', 'Bearer ' + token)
  const session = await installationAuth(env).api.getSession({ headers })
  if (!session) return new Response('Sign in to this installation', { status: 401 })
  const server = await env.INSTALLATION_DB.prepare("SELECT s.id FROM servers s JOIN memberships m ON m.server_id=s.id WHERE s.public_id=? AND s.status='ready' AND m.user_id=?").bind(serverId, session.user.id).first<{ id: string }>()
  if (!server || !env.ASSETS) return new Response('Server not available', { status: 403 })
  const asset = await env.ASSETS.fetch(new Request(new URL('/', env.PUBLIC_ORIGIN)))
  const htmlReader = asset.body?.getReader(); const htmlChunks: Uint8Array[] = []; let htmlSize = 0
  if (!htmlReader) return new Response('Client unavailable', { status: 503 })
  while (true) { const { done, value } = await htmlReader.read(); if (done) break; htmlSize += value.length; if (htmlSize > 262144) { await htmlReader.cancel(); return new Response('Client document too large', { status: 503 }) } htmlChunks.push(value) }
  const htmlBytes = new Uint8Array(htmlSize); offset = 0; for (const chunk of htmlChunks) { htmlBytes.set(chunk, offset); offset += chunk.length }
  const target = new URL(path === '/' ? '/channels' : path, env.PUBLIC_ORIGIN)
  target.searchParams.set('parent', parent)
  const url = target.pathname + target.search + target.hash
  const bootstrap = JSON.stringify({ token, serverId: server.id }).replaceAll('<', '\\u003c')
  const script = `<script>window.__LLLL_BOOTSTRAP__=${bootstrap};history.replaceState(history.state,'',${JSON.stringify(url).replaceAll('<', '\\u003c')});</script>`
  return new Response(new TextDecoder().decode(htmlBytes).replace('</head>', script + '</head>'), { headers: { 'Content-Type': 'text/html;charset=utf-8', 'Cache-Control': 'no-store' } })
}
