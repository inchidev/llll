import { createServer } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { connect, createConnection, createServer as createSocketServer } from 'node:net'
import { TLSSocket } from 'node:tls'
import { lookup } from 'node:dns/promises'
import { readFileSync, rmSync } from 'node:fs'
import { Transform } from 'node:stream'
import { issueHostCertificate } from './box-ca.mjs'

/**
 * The egress proxy of one box on a VPS Node: the box's only way out (ADR 0011).
 *
 * The hosts in effect come from a policy file the daemon rewrites on every change, mounted read-only here:
 * `{revision, hosts, secretHosts}`. Every allowed host is a plain CONNECT tunnel, unopened, except a host some
 * Project secret is bound to: for that one only, the proxy terminates TLS with a certificate from the box's
 * own authority, which the box trusts, and puts each placeholder in effect there in place of its value in the
 * headers, the URL and a text body up to 1 MB, before it opens its own verified TLS connection to the host.
 * A known placeholder that is not in effect at the host refuses the request with 403 and a reason. Responses
 * from such a host have the values taken out again, so the box never reads one back.
 *
 * The values and the authority's key reach the proxy only through its control socket, from the daemon's
 * `docker exec`, and live only in this process's memory.
 */
export const publicIPv4 = ip => {
  const parts = ip.split('.').map(Number)
  if (parts.length !== 4 || parts.some(p => !Number.isInteger(p) || p < 0 || p > 255)) return false
  const [a,b] = parts
  return a > 0 && a !== 10 && a !== 127 && a < 224 && !(a === 169 && b === 254) && !(a === 172 && b >= 16 && b <= 31)
    && !(a === 192 && [0,168].includes(b)) && !(a === 100 && b >= 64 && b <= 127) && !(a === 198 && [18,19,51].includes(b)) && !(a === 203 && b === 0)
}
export async function destination(host, allowed, resolver = lookup, isPublic = publicIPv4) {
  if (!allowed.includes(host) || !/^(?:[a-z0-9-]+\.)+[a-z]{2,63}$/u.test(host)) throw new Error('Destination denied')
  const addresses = await resolver(host,{all:true,family:4})
  if (!addresses.length || addresses.some(item => !isPublic(item.address))) throw new Error('Destination denied')
  return addresses[0].address
}

export const BODY_LIMIT = 1048576
const PLACEHOLDER = /L4_SECRET_[A-Z0-9_]+/gu
const HOP = new Set(['connection', 'proxy-connection', 'keep-alive', 'transfer-encoding', 'te', 'trailer', 'upgrade', 'proxy-authorization', 'host', 'accept-encoding'])
/** The response headers a terminated connection passes back to the box, by their lower-case name. Content-Length is dropped: the answer streams. */
const RESPONSE_HEADERS = new Map(['Content-Type', 'Content-Encoding', 'Content-Language', 'Content-Disposition', 'Content-Range', 'Content-Location', 'Accept-Ranges',
  'Cache-Control', 'Pragma', 'Expires', 'Age', 'Date', 'ETag', 'Last-Modified', 'Vary', 'Location', 'Link', 'Retry-After', 'WWW-Authenticate', 'Allow', 'Server', 'Warning',
  'Strict-Transport-Security', 'Set-Cookie', 'X-Request-Id', 'X-RateLimit-Limit', 'X-RateLimit-Remaining', 'X-RateLimit-Reset', 'X-RateLimit-Used', 'X-RateLimit-Resource',
  'X-GitHub-Request-Id', 'X-GitHub-Media-Type', 'X-OAuth-Scopes', 'X-Accepted-OAuth-Scopes', 'X-Poll-Interval', 'X-Accepted-GitHub-Permissions', 'Docker-Content-Digest', 'Npm-Notice'].map(name => [name.toLowerCase(), name]))
const TEXT = /^(?:text\/|multipart\/form-data|application\/(?:json|x-www-form-urlencoded|xml|javascript|graphql|x-ndjson|[\w.+-]+\+(?:json|xml)))/iu
const latin1 = value => Buffer.from(value, 'utf8').toString('latin1')
const urlSafe = value => value.replace(/[^A-Za-z0-9\-._~:@!$&'()*+,;=]/gu, encodeURIComponent)

/** What the Agent reads when it sent a placeholder that is not put in at this host. */
export function refusal(placeholder, host, known) {
  const secret = known.find(entry => entry.placeholder === placeholder)
  if (secret && !secret.hosts.includes(host)) return `${placeholder} is not bound to ${host}; it is bound to ${secret.hosts.join(', ')}. Ask a person to bind it to ${host} in the Project’s Secrets. The request was not sent.`
  return `${placeholder} is not open for ${host} for this Task. Ask with request_network_window {"host":"${host}","secrets":["${secret?.name ?? placeholder.slice(10)}"]}; a person may have to approve it. The request was not sent.`
}
/** Replaces the placeholders in effect at `host`; the first known one that is not refuses the request. */
export function replace(text, host, state, encode = value => value) {
  const placeholders = new Set(state.known.map(entry => entry.placeholder))
  const usable = new Map(state.secrets.filter(secret => secret.hosts.includes(host)).map(secret => [secret.placeholder, encode(secret.value)]))
  let refused = null
  const result = text.replace(PLACEHOLDER, token => {
    if (!placeholders.has(token)) return token
    if (usable.has(token)) return usable.get(token)
    refused ??= token
    return token
  })
  return refused ? { refused: refusal(refused, host, state.known) } : { text: result }
}
/** Takes every value out of a response stream again, also where one spans two chunks. */
export function scrubber(values) {
  const pairs = values.filter(Boolean).map(value => ({ value: Buffer.from(value.value), placeholder: Buffer.from(value.placeholder) })).sort((a, b) => b.value.length - a.value.length)
  const keep = Math.max(0, ...pairs.map(pair => pair.value.length - 1))
  let tail = Buffer.alloc(0)
  const clean = buffer => {
    for (const { value, placeholder } of pairs) {
      let index = buffer.indexOf(value)
      if (index < 0) continue
      const parts = []
      let from = 0
      while (index >= 0) { parts.push(buffer.subarray(from, index), placeholder); from = index + value.length; index = buffer.indexOf(value, from) }
      parts.push(buffer.subarray(from))
      buffer = Buffer.concat(parts)
    }
    return buffer
  }
  return new Transform({
    transform(chunk, _encoding, done) {
      const buffer = clean(Buffer.concat([tail, chunk]))
      if (buffer.length > keep) { tail = buffer.subarray(buffer.length - keep); done(null, buffer.subarray(0, buffer.length - keep)) } else { tail = buffer; done() }
    },
    flush(done) { done(null, tail.length ? tail : undefined) },
  })
}
export const scrubText = (text, values) => values.reduce((result, secret) => result.split(secret.value).join(secret.placeholder), text)

/** Reads a request body up to `limit`; past it, the rest stays in the paused stream for a pipe. */
function readPrefix(stream, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    const done = overflow => { stream.off('data', data); stream.off('end', end); stream.off('error', reject); resolve({ body: Buffer.concat(chunks), overflow }) }
    const data = chunk => { chunks.push(chunk); size += chunk.length; if (size > limit) { stream.pause(); done(true) } }
    const end = () => done(false)
    stream.on('data', data); stream.once('end', end); stream.once('error', reject)
  })
}

/**
 * The proxy itself. `resolver`, `isPublic`, `upstreamPort` and `upstreamCa` exist for tests that stand a
 * fake service up on a private address; the proxy's own entry point below never sets them.
 */
export function createEgressProxy({ policyPath, resolver = lookup, isPublic = publicIPv4, upstreamPort = 443, upstreamCa, log = () => {} }) {
  let policy = { revision: null, hosts: [], secretHosts: [] }, seen = null
  let state = { ca: null, known: [], secrets: [] }
  const certificates = new Map()
  /** The daemon's latest word: the file is small and read whole on every request, parsed again only when its text changed. */
  const current = () => {
    try {
      const text = readFileSync(policyPath, 'utf8')
      if (text !== seen) {
        const parsed = JSON.parse(text)
        policy = { revision: String(parsed.revision ?? ''), hosts: Array.isArray(parsed.hosts) ? parsed.hosts.filter(host => typeof host === 'string') : [],
          secretHosts: Array.isArray(parsed.secretHosts) ? parsed.secretHosts.filter(host => typeof host === 'string') : [] }
        seen = text
      }
    } catch { policy = { revision: null, hosts: [], secretHosts: [] }; seen = null }
    return policy
  }
  const certificateFor = host => {
    const cached = certificates.get(host)
    if (cached && cached.until > Date.now()) return cached
    const issued = { ...issueHostCertificate(state.ca, host), until: Date.now() + 86400000 }
    certificates.set(host, issued)
    return issued
  }

  const deny = (response, status, message) => { if (!response.headersSent) response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', Connection: 'close' }); response.end(message + '\n') }
  /** One request on a terminated connection, as the box sent it to `host`. */
  async function terminated(request, response) {
    const { host, address } = request.socket.l4 ?? {}
    if (!host || !current().hosts.includes(host)) return deny(response, 403, 'This host is no longer open for this box.')
    const snapshot = state
    if (!request.url.startsWith('/')) return deny(response, 400, 'Invalid request target')
    const path = replace(request.url, host, snapshot, urlSafe)
    if (path.refused) return deny(response, 403, path.refused)
    const headers = []
    let contentType = '', encoded = false, declared = null
    for (let index = 0; index < request.rawHeaders.length; index += 2) {
      const key = request.rawHeaders[index], lower = key.toLowerCase()
      if (HOP.has(lower)) continue
      const value = replace(request.rawHeaders[index + 1], host, snapshot)
      if (value.refused) return deny(response, 403, value.refused)
      if (lower === 'content-type') contentType = value.text
      if (lower === 'content-encoding' && !/^identity$/iu.test(value.text)) encoded = true
      if (lower === 'content-length') { declared = value.text; continue }
      headers.push([key, value.text])
    }
    // A text body up to the limit is read whole and has its placeholders put in; anything else streams as it came.
    let { body, overflow } = await readPrefix(request, BODY_LIMIT)
    if (!overflow && !encoded && body.length && (!contentType || TEXT.test(contentType))) {
      const replaced = replace(body.toString('latin1'), host, snapshot, latin1)
      if (replaced.refused) return deny(response, 403, replaced.refused)
      body = Buffer.from(replaced.text, 'latin1')
    }
    if (!overflow) headers.push(['Content-Length', String(body.length)])
    else if (declared !== null) headers.push(['Content-Length', declared])
    headers.push(['Host', host], ['Accept-Encoding', 'identity'])
    const values = snapshot.secrets.map(({ placeholder, value }) => ({ placeholder, value }))
    const upstream = httpsRequest({ host, servername: host, port: upstreamPort, method: request.method, path: path.text, headers: headers.flat(), agent: false, ...(upstreamCa ? { ca: upstreamCa } : {}),
      lookup: (_name, options, done) => options?.all ? done(null, [{ address, family: 4 }]) : done(null, address, 4), timeout: 120000 })
    upstream.on('timeout', () => upstream.destroy(new Error('Upstream timeout')))
    upstream.on('error', () => deny(response, 502, 'The host could not be reached.'))
    upstream.on('response', answer => {
      // Only a header this proxy knows reaches the box, under the name it knows it by; the host chooses none.
      try {
        for (const [lower, name] of RESPONSE_HEADERS) {
          const value = answer.headers[lower]
          if (value !== undefined) response.setHeader(name, Array.isArray(value) ? value.map(item => scrubText(item, values)) : scrubText(value, values))
        }
        response.writeHead(answer.statusCode ?? 502)
      } catch { answer.destroy(); return deny(response, 502, 'The host answered badly.') }
      answer.pipe(scrubber(values)).pipe(response)
    })
    if (overflow) { upstream.write(body); request.pipe(upstream) } else upstream.end(body)
  }
  const inner = createServer((request, response) => { terminated(request, response).catch(() => deny(response, 502, 'The request failed.')) })
  inner.headersTimeout = 10000

  const server = createServer((_request, response) => response.writeHead(403).end())
  server.on('connect', async (request, client, head) => {
    client.on('error', () => {})
    try {
      const match = /^([a-z0-9.-]+):443$/u.exec(request.url)
      if (!match) throw new Error('Destination denied')
      const host = match[1], { hosts, secretHosts } = current()
      if (!hosts.includes(host)) {
        client.end(`HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\n\r\n${host} is not open for this box. Ask with request_network_window.\n`)
        return
      }
      const address = await destination(host, hosts, resolver, isPublic)
      if (secretHosts.includes(host)) {
        // A bound secret may go here: open the connection to put it in.
        if (!state.ca) throw new Error('Egress not ready')
        const { key, cert } = certificateFor(host)
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (head.length) client.unshift(head)
        const secure = new TLSSocket(client, { isServer: true, key, cert, ALPNProtocols: ['http/1.1'] })
        secure.l4 = { host, address }
        secure.on('error', () => client.destroy())
        inner.emit('connection', secure)
        return
      }
      const upstream = connect({ host: address, port: upstreamPort })
      upstream.setTimeout(15000,() => upstream.destroy())
      upstream.on('error',() => client.destroy()); client.on('error',() => upstream.destroy())
      upstream.once('connect',() => { upstream.setTimeout(0); client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) upstream.write(head); client.pipe(upstream); upstream.pipe(client) })
    } catch (error) { log('egress.denied', error instanceof Error ? error.message : 'denied'); client.end('HTTP/1.1 403 Forbidden\r\n\r\n') }
  })
  server.headersTimeout = 5000; server.maxConnections = 64

  return {
    server, inner,
    /** The daemon's load: the box's authority, every Project placeholder, and the values in effect. */
    load(next) {
      if (!next?.ca || typeof next.ca.key !== 'string' || typeof next.ca.cert !== 'string' || typeof next.ca.subject !== 'string') throw new Error('Invalid load')
      const secrets = (Array.isArray(next.secrets) ? next.secrets : []).filter(secret => typeof secret?.placeholder === 'string' && typeof secret.value === 'string' && Array.isArray(secret.hosts))
      const known = (Array.isArray(next.known) ? next.known : []).filter(entry => typeof entry?.placeholder === 'string' && Array.isArray(entry.hosts))
      if (state.ca?.key !== next.ca.key) certificates.clear()
      state = { ca: next.ca, known, secrets }
      return { ok: true, revision: next.revision ?? null, secrets: secrets.length }
    },
  }
}

export const CONTROL = '/run/egress/control.sock', POLICY = '/run/l4-policy/policy.json'
/** Serves a proxy on the box network and its control socket, which only a docker exec in this container reaches. */
export function serveEgress(proxy, { port = 8080, control = CONTROL } = {}) {
  proxy.server.listen(port, '0.0.0.0')
  rmSync(control, { force: true })
  const listener = createSocketServer({ allowHalfOpen: true }, socket => {
    const chunks = []
    let size = 0
    socket.on('data', chunk => { chunks.push(chunk); size += chunk.length; if (size > 2000000) socket.destroy() })
    socket.on('end', () => {
      let answer
      try { answer = proxy.load(JSON.parse(Buffer.concat(chunks).toString())) } catch { answer = { ok: false } }
      socket.end(JSON.stringify(answer) + '\n')
    })
    socket.on('error', () => {})
  })
  listener.listen(control)
  return listener
}
if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  if (process.argv[2] === 'load') {
    // From the daemon's docker exec: stdin goes to the running proxy, never to a file.
    const chunks = []
    for await (const chunk of process.stdin) chunks.push(chunk)
    const socket = createConnection(CONTROL)
    socket.on('error', () => { process.stdout.write('{"ok":false}\n'); process.exit(1) })
    socket.end(Buffer.concat(chunks))
    socket.pipe(process.stdout)
  } else serveEgress(createEgressProxy({ policyPath: POLICY, log: (event, detail) => console.warn(event, detail) }))
}
