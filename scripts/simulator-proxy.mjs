import http from 'node:http'
import https from 'node:https'

const listenPort = Number.parseInt(process.env.LLLL_SIMULATOR_PROXY_PORT || '4190', 10)
const upstreamOrigin = new URL(process.env.LLLL_SIMULATOR_PROXY_ORIGIN || 'https://sandbox.llll.gg')

if (upstreamOrigin.protocol !== 'https:') {
  throw new Error('LLLL_SIMULATOR_PROXY_ORIGIN must use HTTPS')
}

function upstreamCookie(value) {
  return value?.replace(/(^|;\s*)df\./gu, '$1__Secure-df.')
}

function localCookie(value) {
  return value
    .replace(/^__Secure-df\./u, 'df.')
    .replace(/;\s*Domain=[^;]+/giu, '')
    .replace(/;\s*Secure/giu, '')
}

http.createServer((request, response) => {
  const headers = {
    ...request.headers,
    host: upstreamOrigin.host,
    origin: upstreamOrigin.origin,
    referer: `${upstreamOrigin.origin}/`,
    'x-forwarded-host': request.headers.host,
    'x-forwarded-proto': 'https',
  }
  if (request.headers.cookie) headers.cookie = upstreamCookie(request.headers.cookie)
  delete headers['content-length']

  const upstream = https.request({
    hostname: upstreamOrigin.hostname,
    port: upstreamOrigin.port || 443,
    path: request.url,
    method: request.method,
    headers,
  }, (upstreamResponse) => {
    process.stdout.write(`${request.method} ${request.url} -> ${upstreamResponse.statusCode}\n`)
    const responseHeaders = { ...upstreamResponse.headers }
    if (responseHeaders.location) {
      responseHeaders.location = responseHeaders.location.replace(upstreamOrigin.origin, `http://localhost:${listenPort}`)
    }
    if (responseHeaders['set-cookie']) {
      responseHeaders['set-cookie'] = responseHeaders['set-cookie'].map(localCookie)
    }
    response.writeHead(upstreamResponse.statusCode || 502, responseHeaders)
    upstreamResponse.pipe(response)
  })

  upstream.on('error', (error) => {
    process.stdout.write(`${request.method} ${request.url} -> ERROR ${error.message}\n`)
    response.writeHead(502, { 'content-type': 'text/plain' })
    response.end(error.message)
  })
  request.pipe(upstream)
}).listen(listenPort, '0.0.0.0', () => {
  process.stdout.write(`Simulator proxy http://localhost:${listenPort} -> ${upstreamOrigin.origin}\n`)
})
