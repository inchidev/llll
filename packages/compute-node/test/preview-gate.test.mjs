import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { connect } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPreviewGate, frameAncestors, parseTicket, ticketSignature, ticketValid } from '../src/preview-gate.mjs'
import { voxlArguments, displaySocket } from '../src/viewer.mjs'

const boxId = '00000000-0000-4000-8000-0000000000c1', otherBox = '00000000-0000-4000-8000-0000000000c2'
const key = 'k'.repeat(64), password = 'p'.repeat(64)
const ticket = (expiresAt, id = boxId, signingKey = key) => `${id}.${expiresAt}.${ticketSignature(signingKey, id, expiresAt)}`

test('a ticket is the box, an expiry and the signature under the box’s key, and opens only that box until it expires', () => {
  const now = 1_800_000_000_000, viewer = { boxId, key }
  assert.deepEqual(parseTicket(ticket(now + 1000)), { boxId, expiresAt: now + 1000, signature: ticketSignature(key, boxId, now + 1000) })
  assert.equal(ticketValid(parseTicket(ticket(now + 1000)), viewer, now), true)
  assert.equal(ticketValid(parseTicket(ticket(now)), viewer, now), false)
  assert.equal(ticketValid(parseTicket(ticket(now + 1000, boxId, 'x'.repeat(64))), viewer, now), false)
  assert.equal(ticketValid(parseTicket(ticket(now + 1000, otherBox)), viewer, now), false)
  for (const bad of [undefined, '', 'nope', `${boxId}.123.${'a'.repeat(64)}`, `${boxId}.${now}.${'A'.repeat(64)}`]) assert.equal(parseTicket(bad), null)
  assert.equal(frameAncestors(['https://acme.llll.gg', 'https://afterprompt.games', 'https://acme.llll.gg']), "frame-ancestors 'self' https://acme.llll.gg https://afterprompt.games")
})

test('voxl in a viewer only shows the screen: no input, sound, files or clipboard, and only the named sites embed its client', () => {
  const args = voxlArguments(['https://acme.llll.gg', 'javascript:alert(1)', 'https://afterprompt.games'])
  for (const flag of ['--addr=127.0.0.1', '--port=6902', '--read-only=true', '--audio-enabled=false', '--enable-clipboard=false', '--file-transfers=none', '--microphone-enabled=false', '--enable-resize=false'])
    assert.ok(args.includes(flag), flag)
  assert.ok(args.includes('--allowed-origins=https://acme.llll.gg,https://afterprompt.games'))
  assert.equal(displaySocket(':99'), '/tmp/.X11-unix/X99')
})

/** voxl as the gate sees it: an HTTP server on a Unix socket that records what reaches it, with a WebSocket-style upgrade. */
async function fakeVoxl(directory) {
  const seen = [], socket = join(directory, 'voxl.sock')
  const server = createServer((request, response) => {
    seen.push({ path: request.url, authorization: request.headers.authorization, cookie: request.headers.cookie })
    response.writeHead(200, { 'content-type': 'text/plain', 'x-frame-options': 'DENY' })
    response.end(`voxl ${request.url}`)
  })
  const clients = new Set()
  server.on('upgrade', (request, client) => {
    clients.add(client)
    seen.push({ path: request.url, authorization: request.headers.authorization, upgrade: request.headers.upgrade })
    client.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
    client.on('data', chunk => client.write(Buffer.concat([Buffer.from('echo:'), chunk])))
  })
  await new Promise(resolve => server.listen(socket, resolve))
  return { seen, socket, close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); for (const client of clients) client.destroy() }) }
}

test('the gate lets voxl’s assets through, asks a ticket for everything else, and speaks to voxl with its own password', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'l4-gate-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const voxl = await fakeVoxl(directory)
  const clock = { now: 1_800_000_000_000 }
  const viewer = { boxId, key, password, socket: voxl.socket }
  const gate = createPreviewGate({ viewers: { get: id => (id === boxId ? viewer : null), any: () => viewer }, origins: ['https://acme.llll.gg', 'https://afterprompt.games'], now: () => clock.now })
  const { port } = await gate.listen(0)
  t.after(async () => { await gate.close(); await voxl.close() })
  const base = `http://127.0.0.1:${port}`

  const asset = await fetch(`${base}/client.js`, { headers: { cookie: 'lizard_access=provider-cookie' } })
  assert.equal(asset.status, 200)
  assert.equal(asset.headers.get('content-security-policy'), "frame-ancestors 'self' https://acme.llll.gg https://afterprompt.games")
  assert.equal(asset.headers.get('x-frame-options'), null)
  assert.equal((await fetch(`${base}/`)).status, 401)
  assert.equal((await fetch(`${base}/?token=${ticket(clock.now - 1)}`)).status, 401)
  assert.equal((await fetch(`${base}/?token=${ticket(clock.now + 60_000, otherBox)}`)).status, 401)
  const page = await fetch(`${base}/?token=${ticket(clock.now + 60_000)}`, { headers: { authorization: 'Bearer forged', cookie: 'lizard_access=provider-cookie' } })
  assert.equal(page.status, 200)
  assert.equal(await page.text(), `voxl /?token=${ticket(clock.now + 60_000)}`)
  // voxl hears its own password, never the viewer's credentials or the provider's cookie.
  assert.deepEqual(voxl.seen.map(({ authorization, cookie }) => ({ authorization, cookie })), [{ authorization: `Bearer ${password}`, cookie: undefined }, { authorization: `Bearer ${password}`, cookie: undefined }])

  // The stream: one upgrade, checked like a request, then carried both ways.
  const upgrade = async token => {
    const client = connect(port, '127.0.0.1')
    await new Promise(resolve => client.once('connect', resolve))
    client.write(`GET /websocket${token ? `?token=${token}` : ''} HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n`)
    const head = await new Promise(resolve => client.once('data', chunk => resolve(chunk.toString())))
    return { client, head }
  }
  const refused = await upgrade(null)
  assert.match(refused.head, /^HTTP\/1\.1 401/u)
  refused.client.destroy()
  const stream = await upgrade(ticket(clock.now + 60_000))
  assert.match(stream.head, /^HTTP\/1\.1 101/u)
  stream.client.write('frame')
  assert.equal(await new Promise(resolve => stream.client.once('data', chunk => resolve(chunk.toString()))), 'echo:frame')
  assert.deepEqual(voxl.seen.at(-1), { path: `/websocket?token=${ticket(clock.now + 60_000)}`, authorization: `Bearer ${password}`, upgrade: 'websocket' })
  // An open stream outlives its ticket; a new connection after the expiry does not.
  clock.now += 120_000
  stream.client.write('still')
  assert.equal(await new Promise(resolve => stream.client.once('data', chunk => resolve(chunk.toString()))), 'echo:still')
  stream.client.destroy()
  assert.equal((await fetch(`${base}/?token=${ticket(clock.now - 60_000)}`)).status, 401)
})

test('without a running viewer the gate answers nothing but its refusal', async t => {
  const gate = createPreviewGate({ viewers: { get: () => null, any: () => null }, origins: [] })
  const { port } = await gate.listen(0)
  t.after(() => gate.close())
  assert.equal((await fetch(`http://127.0.0.1:${port}/healthz`)).status, 401)
  assert.equal((await fetch(`http://127.0.0.1:${port}/?token=${ticket(Date.now() + 60_000)}`)).status, 401)
})
