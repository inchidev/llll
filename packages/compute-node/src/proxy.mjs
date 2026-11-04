import { createServer } from 'node:http'
import { connect } from 'node:net'
import { lookup } from 'node:dns/promises'

export const publicIPv4 = ip => {
  const parts = ip.split('.').map(Number)
  if (parts.length !== 4 || parts.some(p => !Number.isInteger(p) || p < 0 || p > 255)) return false
  const [a,b] = parts
  return a > 0 && a !== 10 && a !== 127 && a < 224 && !(a === 169 && b === 254) && !(a === 172 && b >= 16 && b <= 31)
    && !(a === 192 && [0,168].includes(b)) && !(a === 100 && b >= 64 && b <= 127) && !(a === 198 && [18,19,51].includes(b)) && !(a === 203 && b === 0)
}
export async function destination(host, allowed, resolver = lookup) {
  if (!allowed.includes(host) || !/^(?:[a-z0-9-]+\.)+[a-z]{2,63}$/u.test(host)) throw new Error('Destination denied')
  const addresses = await resolver(host,{all:true,family:4})
  if (!addresses.length || addresses.some(item => !publicIPv4(item.address))) throw new Error('Destination denied')
  return addresses[0].address
}
if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  const allowed = JSON.parse(process.env.LLLL_EGRESS_HOSTS || '[]')
  const server = createServer((_request,response) => response.writeHead(403).end())
  server.on('connect',async (request,client,head) => {
    try {
      const match = /^([a-z0-9.-]+):443$/u.exec(request.url)
      if (!match) throw new Error('Destination denied')
      const ip = await destination(match[1],allowed)
      const upstream = connect({host:ip,port:443})
      upstream.setTimeout(15000,() => upstream.destroy())
      upstream.on('error',() => client.destroy()); client.on('error',() => upstream.destroy())
      upstream.once('connect',() => { client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) upstream.write(head); client.pipe(upstream); upstream.pipe(client) })
    } catch { client.end('HTTP/1.1 403 Forbidden\r\n\r\n') }
  })
  server.headersTimeout=5000; server.maxConnections=32
  server.listen(8080,'0.0.0.0')
}
