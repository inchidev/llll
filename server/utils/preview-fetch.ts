import { assertPublicHttpUrl } from '../../shared/public-http'

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const HEADER_LIMIT = 32_768

/** DNS is checked before connecting, then the socket uses that exact address with the original TLS name. */
async function publicAddress(url: URL, signal: AbortSignal): Promise<string> {
  const hostname = url.hostname.replace(/^\[|\]$/g, '')
  if (hostname.includes(':') || /^[\d.]+$/.test(hostname)) return hostname
  const response = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=A`, {
    headers: { Accept: 'application/dns-json' }, redirect: 'manual', signal,
  })
  const bytes = await boundedBytes(response, HEADER_LIMIT)
  if (!response.ok) throw new Error('DNS unavailable')
  const answer = JSON.parse(decoder.decode(bytes)) as { Answer?: { type: number; data: string }[] }
  const addresses = (answer.Answer ?? []).filter(item => item.type === 1).map(item => item.data)
  if (!addresses.length) throw new Error('No public address')
  for (const address of addresses) {
    if (!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(address)) throw new Error('Invalid DNS answer')
    assertPublicHttpUrl(`https://${address}/`)
  }
  return addresses[0]!
}

export async function boundedBytes(response: Response, limit: number): Promise<Uint8Array> {
  if (Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel()
    throw new Error('Preview is too large')
  }
  const reader = response.body?.getReader()
  if (!reader) return new Uint8Array()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > limit) throw new Error('Preview is too large')
      chunks.push(chunk.value)
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  return bytes
}

/** Strict, bounded HTTP/1.1 response decoder for the pinned self-host transport. No compressed bodies. */
export function decodePreviewResponse(bytes: Uint8Array, limit: number): Response {
  const headEnd = bytes.findIndex((byte, i) => byte === 13 && bytes[i + 1] === 10 && bytes[i + 2] === 13 && bytes[i + 3] === 10)
  if (headEnd < 0 || headEnd > HEADER_LIMIT) throw new Error('Invalid response headers')
  const lines = decoder.decode(bytes.subarray(0, headEnd)).split('\r\n')
  const status = Number(lines.shift()?.match(/^HTTP\/1\.[01] (\d{3})(?: |$)/)?.[1])
  if (status < 200 || status > 599 || !status) throw new Error('Invalid status')
  const headers = new Headers()
  for (const line of lines) {
    const colon = line.indexOf(':')
    if (colon < 1 || /^\s/.test(line)) throw new Error('Invalid header')
    headers.append(line.slice(0, colon), line.slice(colon + 1).trim())
  }
  if (headers.has('content-encoding') && headers.get('content-encoding') !== 'identity') throw new Error('Unsupported encoding')
  let body = bytes.subarray(headEnd + 4)
  if (headers.has('transfer-encoding')) {
    if (headers.get('transfer-encoding')?.toLowerCase() !== 'chunked' || headers.has('content-length')) throw new Error('Invalid framing')
    const output = new Uint8Array(Math.min(body.length, limit))
    let cursor = 0, written = 0
    while (true) {
      let end = cursor
      while (end < body.length && !(body[end] === 13 && body[end + 1] === 10)) end++
      if (end === body.length || end - cursor > 128) throw new Error('Invalid chunk')
      const sizeText = decoder.decode(body.subarray(cursor, end)).split(';')[0]!
      if (!/^[a-f\d]+$/i.test(sizeText)) throw new Error('Invalid chunk length')
      const size = Number.parseInt(sizeText, 16)
      cursor = end + 2
      if (size === 0) {
        if (body[cursor] !== 13 || body[cursor + 1] !== 10 || cursor + 2 !== body.length) throw new Error('Invalid chunk ending')
        break
      }
      if (written + size > limit || cursor + size + 2 > body.length || body[cursor + size] !== 13 || body[cursor + size + 1] !== 10) throw new Error('Invalid chunk body')
      output.set(body.subarray(cursor, cursor + size), written)
      written += size; cursor += size + 2
    }
    body = output.subarray(0, written)
    headers.delete('transfer-encoding')
  } else if (headers.has('content-length')) {
    const length = headers.get('content-length')!
    if (!/^\d+$/.test(length) || Number(length) !== body.byteLength) throw new Error('Incomplete body')
  }
  if (body.byteLength > limit) throw new Error('Preview is too large')
  headers.delete('content-length')
  return new Response([204, 205, 304].includes(status) ? null : new Uint8Array(body).buffer, { status, headers })
}

async function pinnedFetch(url: URL, limit: number, signal: AbortSignal): Promise<Response> {
  const address = await publicAddress(url, signal)
  const { connect } = await import('cloudflare:sockets')
  let socket = connect({ hostname: address, port: url.protocol === 'https:' ? 443 : 80 }, { secureTransport: url.protocol === 'https:' ? 'starttls' : 'off', allowHalfOpen: false })
  const close = () => { void socket.close().catch(() => {}) }
  signal.addEventListener('abort', close, { once: true })
  try {
    signal.throwIfAborted()
    await socket.opened
    if (url.protocol === 'https:') {
      socket = socket.startTls({ expectedServerHostname: url.hostname.replace(/^\[|\]$/g, '') })
      await socket.opened
    }
    const writer = socket.writable.getWriter()
    await writer.write(encoder.encode(`GET ${url.pathname}${url.search} HTTP/1.1\r\nHost: ${url.host}\r\nAccept: text/html,image/png,image/jpeg,image/webp,image/gif\r\nAccept-Encoding: identity\r\nUser-Agent: L4-LinkPreview/1.0\r\nConnection: close\r\n\r\n`))
    writer.releaseLock()
    const bytes = await boundedBytes(new Response(socket.readable), limit + HEADER_LIMIT)
    return decodePreviewResponse(bytes, limit)
  } finally { signal.removeEventListener('abort', close); close() }
}

/** No cookies, authorization, referrer, nonstandard ports, or unchecked redirects reach a destination. */
export async function fetchPreview(raw: string, serverHosts: string[], limit: number, signal: AbortSignal, cloudflareEgress = false): Promise<Response> {
  let target = raw
  for (let hop = 0; hop < 4; hop++) {
    const url = assertPublicHttpUrl(target, serverHosts)
    if (url.port) throw new Error('Only standard website ports are supported')
    url.hash = ''
    // Cloudflare's global fetch enforces public-network egress. celld and development do not;
    // never use their ambient fetch for an untrusted hostname after a separate DNS check.
    const edge = cloudflareEgress && typeof navigator !== 'undefined' && navigator.userAgent === 'Cloudflare-Workers'
    const response = edge
      ? await fetch(url, { redirect: 'manual', credentials: 'omit', signal, headers: { Accept: 'text/html,image/png,image/jpeg,image/webp,image/gif', 'User-Agent': 'L4-LinkPreview/1.0' } })
      : await pinnedFetch(url, limit, signal)
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location')
      await response.body?.cancel()
      if (!location) throw new Error('Missing redirect destination')
      target = new URL(location, url).href
      continue
    }
    const headers = new Headers(response.headers)
    headers.set('x-l4-preview-url', url.href)
    return new Response(response.body, { status: response.status, headers })
  }
  throw new Error('Too many redirects')
}
