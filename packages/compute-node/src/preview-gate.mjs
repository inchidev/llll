import { createHmac, timingSafeEqual } from 'node:crypto'
import { createServer, request as httpRequest } from 'node:http'
import { connect } from 'node:net'

/** What voxl's page loads before it has its token, and its health check: the same for every box's viewer. */
export const PUBLIC_PATHS = new Set(['/client.js', '/worker.js', '/audio.js', '/mic.js', '/favicon.ico', '/inter.woff2', '/healthz'])
const HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'te', 'trailer', 'upgrade', 'proxy-authorization', 'authorization', 'cookie'])

/** The signature of a viewer's ticket: the box, until when, under the box's preview key from the Server. */
export const ticketSignature = (key, boxId, expiresAt) => createHmac('sha256', key).update(`${boxId}.${expiresAt}`).digest('hex')

/** A ticket `<box id>.<expires, ms>.<signature>`, as the Server mints it, or null when it is not one. */
export function parseTicket(value) {
  const match = /^([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})\.(\d{13})\.([a-f0-9]{64})$/u.exec(value ?? '')
  return match ? { boxId: match[1], expiresAt: Number(match[2]), signature: match[3] } : null
}

/** Whether a ticket opens this viewer now. */
export function ticketValid(ticket, viewer, now = Date.now()) {
  if (!ticket || !viewer || ticket.boxId !== viewer.boxId || ticket.expiresAt <= now) return false
  const expected = Buffer.from(ticketSignature(viewer.key, ticket.boxId, ticket.expiresAt), 'hex'), given = Buffer.from(ticket.signature, 'hex')
  return expected.length === given.length && timingSafeEqual(expected, given)
}

/** The page may be framed only by the Server and the origins the Node was told (a partner's site). */
export const frameAncestors = origins => `frame-ancestors 'self' ${[...new Set(origins)].join(' ')}`.trim()

/**
 * The Node's preview gate: the one port a provider exposes (L4 Compute's HTTPS address of the sandbox), in front of
 * the viewers of this Node's boxes. Every request but voxl's public assets needs a ticket the Server minted for one
 * person and a short time (`?token=`, which voxl's page passes on to its socket); the gate then speaks to that box's
 * voxl over its Unix socket with voxl's own password, which never leaves the daemon and the viewer. Viewing takes
 * no turn and keeps no box running. A ticket ends new connections when it expires; an open stream ends with the box.
 */
export function createPreviewGate({ viewers, origins = [], now = Date.now, log = () => {} }) {
  const choose = url => {
    if (PUBLIC_PATHS.has(url.pathname)) return viewers.any()
    const ticket = parseTicket(url.searchParams.get('token'))
    const viewer = ticket ? viewers.get(ticket.boxId) : null
    return ticketValid(ticket, viewer, now()) ? viewer : null
  }
  const headersFor = (incoming, viewer) => {
    const headers = {}
    for (const [name, value] of Object.entries(incoming)) if (!HOP.has(name)) headers[name] = value
    headers.authorization = `Bearer ${viewer.password}`
    return headers
  }
  const refuse = response => {
    response.writeHead(401, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
    response.end('This preview link has expired or the box is not running. Open the preview again.')
  }

  const server = createServer((request, response) => {
    let url
    try { url = new URL(request.url, 'http://gate') } catch { response.writeHead(400).end(); return }
    const viewer = choose(url)
    if (!viewer) { request.resume(); refuse(response); return }
    const upstream = httpRequest({ socketPath: viewer.socket, method: request.method, path: request.url, headers: headersFor(request.headers, viewer) }, answer => {
      const headers = { ...answer.headers }
      delete headers['x-frame-options']
      headers['content-security-policy'] = frameAncestors(origins)
      headers['cache-control'] ??= 'no-store'
      response.writeHead(answer.statusCode ?? 502, headers)
      answer.pipe(response)
    })
    upstream.on('error', () => { if (!response.headersSent) response.writeHead(502, { 'content-type': 'text/plain' }); response.end('The box viewer is not answering.') })
    request.pipe(upstream)
  })
  // voxl's stream is one WebSocket: checked like any request, then carried byte for byte.
  const streams = new Set()
  server.on('upgrade', (request, socket, head) => {
    streams.add(socket)
    socket.on('close', () => streams.delete(socket))
    socket.on('error', () => {})
    let url
    try { url = new URL(request.url, 'http://gate') } catch { socket.destroy(); return }
    const viewer = choose(url)
    if (!viewer || PUBLIC_PATHS.has(url.pathname)) { socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); return }
    const upstream = connect(viewer.socket)
    upstream.on('error', () => socket.destroy())
    socket.on('close', () => upstream.destroy())
    upstream.on('connect', () => {
      const headers = { ...headersFor(request.headers, viewer), connection: 'Upgrade', upgrade: request.headers.upgrade ?? 'websocket' }
      upstream.write(`${request.method} ${request.url} HTTP/1.1\r\n${Object.entries(headers).map(([name, value]) => `${name}: ${Array.isArray(value) ? value.join(', ') : value}`).join('\r\n')}\r\n\r\n`)
      if (head?.length) upstream.write(head)
      upstream.pipe(socket).pipe(upstream)
    })
  })
  server.on('clientError', (_error, socket) => socket.destroy())
  return {
    server,
    listen: (port, host = '127.0.0.1') => new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => { log('compute.preview_gate', { port }); resolve(server.address()) }) }),
    /** Stops listening and ends every connection, open streams included. */
    close: () => new Promise(resolve => {
      server.close(() => resolve())
      server.closeAllConnections()
      for (const socket of streams) socket.destroy()
    }),
  }
}
