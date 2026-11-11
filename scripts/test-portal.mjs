import assert from 'node:assert/strict'

/**
 * Portal (ADR 0014) on a real Server runtime: opening one, its page and CSP, the host and guest sockets
 * relaying through its Durable Object, refusals, and ending it.
 */
export async function testPortal({ api, runtime, origin, channelId }) {
  const opened = (await api('alpha', `/api/channels/${channelId}/portals`, { method: 'POST' })).payload
  assert.match(opened.portalId, /^[0-9a-f-]{36}$/)
  assert.equal(opened.url, `${origin}/portal/${opened.portalId}`)
  const guestKey = new URL(opened.guestUrl).hash.replace(/^#t=/, '')
  const hostKey = new URL(opened.hostLink).searchParams.get('key')
  assert.ok(guestKey.length >= 40 && hostKey.length >= 40 && guestKey !== hostKey)
  await api('alpha', `/api/channels/${channelId}/portals`, { method: 'POST', actor: 'anonymous', expected: 401 })

  const page = await runtime.dispatchFetch(opened.url)
  assert.equal(page.status, 200)
  const csp = page.headers.get('content-security-policy')
  assert.match(csp, /frame-ancestors 'none'/)
  assert.match(csp, /script-src [^;]*'sha256-/)
  assert.match(await page.text(), /<html/)

  const socket = async (path) => {
    const response = await runtime.dispatchFetch(opened.url + path, { headers: { Upgrade: 'websocket' } })
    assert.equal(response.status, 101, `Portal socket ${path}: ${response.status} ${response.status === 101 ? '' : await response.text()}`)
    const ws = response.webSocket
    const frames = []
    const closed = new Promise(resolve => ws.addEventListener('close', event => resolve(event.code)))
    ws.addEventListener('message', event => frames.push(typeof event.data === 'string' ? JSON.parse(event.data) : event.data))
    ws.accept()
    return { ws, frames, closed }
  }
  const until = async (check, label) => {
    for (let i = 0; i < 100; i++) {
      if (check()) return
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    assert.fail(`Portal: ${label}`)
  }

  // A host offering relay protocol v2 on a Server without a Realtime SFU app is answered as v1.
  const v2Host = await socket('/host')
  v2Host.ws.send(JSON.stringify({ t: 'host', key: hostKey, v: 2 }))
  await until(() => v2Host.frames.length >= 1, 'a v2 host is answered')
  assert.deepEqual(v2Host.frames[0], { t: 'pp.ready' })
  v2Host.ws.close(1000)
  await v2Host.closed

  const guest = await socket('/ws')
  guest.ws.send(JSON.stringify({ t: 'auth', token: guestKey }))
  await until(() => guest.frames.some(frame => frame.t === 'pp.wait'), 'the guest waits for the host')

  const host = await socket('/host')
  host.ws.send(JSON.stringify({ t: 'host', key: hostKey, v: 1 }))
  await until(() => host.frames.length >= 3, 'the host is told about the waiting guest')
  assert.deepEqual(host.frames.slice(0, 3), [{ t: 'pp.ready' }, { t: 'pp.guest', open: true }, { t: 'auth', token: guestKey }])

  guest.ws.send(JSON.stringify({ t: 'm', x: 0.5, y: 0.5 }))
  host.ws.send(JSON.stringify({ t: 'hello' }))
  await until(() => host.frames.some(frame => frame.t === 'm') && guest.frames.some(frame => frame.t === 'hello'), 'frames pass both ways')

  const stranger = await socket('/ws')
  stranger.ws.send(JSON.stringify({ t: 'auth', token: hostKey }))
  assert.equal(await stranger.closed, 4401)
  const oldHost = await socket('/host')
  oldHost.ws.send(JSON.stringify({ t: 'host', key: hostKey, v: 99 }))
  assert.equal(await oldHost.closed, 4426)

  await api('alpha', `/api/channels/${channelId}/portals/${opened.portalId}`, { method: 'DELETE', actor: 'anonymous', expected: 401 })
  await api('alpha', `/api/channels/${channelId}/portals/${opened.portalId}`, { method: 'DELETE' })
  assert.equal(await guest.closed, 4404)
  assert.equal(await host.closed, 4404)
  assert.equal((await runtime.dispatchFetch(opened.url)).status, 404)
  console.log('PASS: Portal opens with two keys, serves its guest page, answers v2 as v1 without an SFU, relays host and guest, refuses wrong keys and old protocols, and ends')
}
