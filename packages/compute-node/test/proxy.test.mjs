import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer as createHttpsServer } from 'node:https'
import { request as httpRequest } from 'node:http'
import { connect as tlsConnect, createSecureContext } from 'node:tls'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBoxCa, issueHostCertificate } from '../src/box-ca.mjs'
import { createEgressProxy, destination, publicIPv4, scrubber } from '../src/proxy.mjs'

test('egress proxy denies private, rebinding, unselected and numeric destinations',async()=>{
  for(const ip of ['127.0.0.1','10.1.2.3','169.254.169.254','172.17.0.1','192.168.0.1','100.100.100.100','0.0.0.0','::1','224.0.0.1'])assert.equal(publicIPv4(ip),false)
  await assert.rejects(destination('attacker.example',['registry.npmjs.org']))
  await assert.rejects(destination('registry.npmjs.org',['registry.npmjs.org'],async()=>[{address:'127.0.0.1'}]))
  await assert.rejects(destination('registry.npmjs.org',['registry.npmjs.org'],async()=>[{address:'1.1.1.1'},{address:'10.0.0.1'}]))
  assert.equal(await destination('registry.npmjs.org',['registry.npmjs.org'],async()=>[{address:'1.1.1.1'}]),'1.1.1.1')
})


const secretValue = '123456:real-telegram-token'
/** A service on 127.0.0.1 standing in for public hosts, with its own authority, recording what reached it. */
async function fakeHosts() {
  const authority = createBoxCa('00000000-0000-4000-8000-0000000000f0'), received = []
  const contexts = Object.fromEntries(['api.telegram.org', 'registry.npmjs.org'].map(host => [host, createSecureContext(issueHostCertificate(authority, host))]))
  const server = createHttpsServer({ SNICallback: (name, done) => done(null, contexts[name]) }, (request, response) => {
    const chunks = []
    request.on('data', chunk => chunks.push(chunk)).on('end', () => {
      const body = Buffer.concat(chunks).toString()
      received.push({ host: request.headers.host, method: request.method, url: request.url, headers: request.headers, body })
      // An echo, as a service that repeats what it was sent would answer.
      response.writeHead(200, { 'Content-Type': 'application/json', 'Warning': String(request.headers.authorization ?? '') }).end(JSON.stringify({ url: request.url, body }))
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { authority, received, server, port: server.address().port }
}
/** A request the way a box makes one: CONNECT through the proxy, then TLS to the host over that tunnel. */
function through(proxyPort, host, ca, { method = 'GET', path = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const tunnel = httpRequest({ host: '127.0.0.1', port: proxyPort, method: 'CONNECT', path: `${host}:443` })
    tunnel.on('connect', (answer, socket) => {
      if (answer.statusCode !== 200) { socket.destroy(); resolve({ status: answer.statusCode, connect: true }); return }
      const secure = tlsConnect({ socket, servername: host, ca })
      secure.on('error', reject)
      // Plain HTTP over the TLS connection to the host inside the tunnel, never a connection of its own.
      const request = httpRequest({ host, path, method, headers: { Host: host, ...headers }, createConnection: () => secure }, response => {
        const chunks = []
        response.on('data', chunk => chunks.push(chunk)).on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString() }))
      })
      request.on('error', reject)
      request.end(body)
    })
    tunnel.on('error', reject)
    tunnel.end()
  })
}

test('the proxy tunnels open hosts, refuses closed ones, and terminates TLS only where a secret is bound', async () => {
  const hosts = await fakeHosts(), directory = await mkdtemp(join(tmpdir(), 'l4-egress-')), policyPath = join(directory, 'policy.json')
  const box = createBoxCa('00000000-0000-4000-8000-0000000000f1')
  await writeFile(policyPath, JSON.stringify({ revision: 'r1', hosts: ['server.example', 'registry.npmjs.org', 'api.telegram.org'], secretHosts: ['api.telegram.org'] }))
  // Only a test resolves these hosts to a private address; the proxy's own entry point always uses DNS and public addresses.
  const proxy = createEgressProxy({ policyPath, resolver: async () => [{ address: '127.0.0.1' }], isPublic: () => true, upstreamPort: hosts.port, upstreamCa: hosts.authority.cert })
  await new Promise(resolve => proxy.server.listen(0, '127.0.0.1', resolve))
  const port = proxy.server.address().port
  try {
    proxy.load({ revision: 'r1', ca: box, known: [{ placeholder: 'L4_SECRET_TELEGRAM_TOKEN', name: 'TELEGRAM_TOKEN', hosts: ['api.telegram.org'] }, { placeholder: 'L4_SECRET_DEPLOY_KEY', name: 'DEPLOY_KEY', hosts: ['api.telegram.org'] }],
      secrets: [{ placeholder: 'L4_SECRET_TELEGRAM_TOKEN', hosts: ['api.telegram.org'], value: secretValue }] })

    assert.deepEqual(await through(port, 'attacker.example', hosts.authority.cert), { status: 403, connect: true })

    // A host without a bound secret is a tunnel: the box sees the host's own certificate, and nothing is replaced.
    const plain = await through(port, 'registry.npmjs.org', hosts.authority.cert, { path: '/L4_SECRET_TELEGRAM_TOKEN', headers: { Authorization: 'Bearer L4_SECRET_TELEGRAM_TOKEN' } })
    assert.equal(plain.status, 200, JSON.stringify(plain))
    assert.deepEqual([hosts.received.at(-1).url, hosts.received.at(-1).headers.authorization], ['/L4_SECRET_TELEGRAM_TOKEN', 'Bearer L4_SECRET_TELEGRAM_TOKEN'])
    await assert.rejects(through(port, 'registry.npmjs.org', box.cert), 'a tunnel is never opened with the box’s authority')

    // The bound host: the box trusts its own authority, the value goes in the URL, a header and a JSON body, and comes back out of the answer.
    const sent = await through(port, 'api.telegram.org', box.cert, { method: 'POST', path: '/botL4_SECRET_TELEGRAM_TOKEN/sendMessage?check=L4_SECRET_TELEGRAM_TOKEN',
      headers: { Authorization: 'Bearer L4_SECRET_TELEGRAM_TOKEN', 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'token L4_SECRET_TELEGRAM_TOKEN', other: 'L4_SECRET_UNKNOWN' }) })
    const upstream = hosts.received.at(-1)
    assert.equal(sent.status, 200)
    assert.equal(upstream.url, `/bot${secretValue}/sendMessage?check=${secretValue}`)
    assert.equal(upstream.headers.authorization, `Bearer ${secretValue}`)
    assert.deepEqual(JSON.parse(upstream.body), { text: `token ${secretValue}`, other: 'L4_SECRET_UNKNOWN' })
    assert.ok(!sent.body.includes(secretValue) && !JSON.stringify(sent.headers).includes(secretValue), 'the box never reads the value back')
    assert.equal(sent.headers.warning, 'Bearer L4_SECRET_TELEGRAM_TOKEN')

    // A known placeholder not in effect here is refused with a reason, and the host never sees the request.
    const count = hosts.received.length
    const refused = await through(port, 'api.telegram.org', box.cert, { headers: { 'X-Key': 'L4_SECRET_DEPLOY_KEY' } })
    assert.equal(refused.status, 403)
    assert.match(refused.body, /request_network_window .*DEPLOY_KEY/u)
    assert.equal(hosts.received.length, count)
    // A binary body is passed as it came.
    await through(port, 'api.telegram.org', box.cert, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: 'L4_SECRET_TELEGRAM_TOKEN' })
    assert.equal(hosts.received.at(-1).body, 'L4_SECRET_TELEGRAM_TOKEN')

    // The daemon closes the window: the file changes and the next CONNECT is refused.
    await new Promise(resolve => setTimeout(resolve, 20))
    await writeFile(policyPath, JSON.stringify({ revision: 'r2', hosts: ['server.example'], secretHosts: [] }))
    assert.deepEqual(await through(port, 'api.telegram.org', box.cert), { status: 403, connect: true })
  } finally {
    for (const server of [proxy.server, proxy.inner, hosts.server]) { server.closeAllConnections?.(); server.close() }
    await rm(directory, { recursive: true, force: true })
  }
})

test('a response has the values taken out even where one spans two chunks', async () => {
  const stream = scrubber([{ placeholder: 'L4_SECRET_A', value: 'abcdefgh' }])
  const out = []
  stream.on('data', chunk => out.push(chunk))
  const ended = new Promise(resolve => stream.on('end', resolve))
  for (const part of ['xx abcd', 'efgh yy abc', 'defghabcdefgh', ' zz']) stream.write(part)
  stream.end()
  await ended
  assert.equal(Buffer.concat(out).toString(), 'xx L4_SECRET_A yy L4_SECRET_AL4_SECRET_A zz')
})
