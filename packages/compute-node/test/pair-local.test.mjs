import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createHmac, randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { collectProcess } from '../src/process.mjs'
import { openNodeState } from '../src/state-store.mjs'

const program = fileURLToPath(new URL('../src/pair-local.mjs', import.meta.url))
const secret = 'local-secret-with-at-least-32-characters'

/** A stand-in Server that checks the host signature and answers as the local-pair endpoint does. */
async function localServer(answer) {
  const requests = []
  const server = createServer((request, response) => {
    let raw = ''
    request.on('data', chunk => { raw += chunk })
    request.on('end', () => {
      const origin = `http://127.0.0.1:${server.address().port}`
      const signature = createHmac('sha256', secret).update('l4-local-compute-v1\n' + origin + '\n' + raw).digest('hex')
      assert.equal(request.headers['x-l4-local-signature'], signature)
      const body = JSON.parse(raw)
      requests.push(body)
      const { status, json } = answer(body)
      response.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(json))
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { server, requests, origin: `http://127.0.0.1:${server.address().port}` }
}

async function pairLocal(directory, origin, image) {
  await writeFile(join(directory, '.env'), `AUTH_SECRET='${secret}'\nPUBLIC_ORIGIN='${origin}'\n`)
  const child = spawn(process.execPath, [program, join(directory, '.env')],
    { env: { ...process.env, LLLL_SERVER_ORIGIN: origin, LLLL_NODE_STATE: join(directory, 'state'), LLLL_WORKSPACE_IMAGE: image } })
  return collectProcess(child, { timeoutMs: 20000, limit: 20000 })
}

test('a paired local Node says what it runs at each start with its own credential, so an update replaces it in place', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'l4-pair-local-'))
  const serverId = randomUUID()
  const stand = await localServer(() => ({ status: 200, json: { serverId } }))
  try {
    const first = await pairLocal(directory, stand.origin, 'sha256:' + 'a'.repeat(64))
    assert.equal(first.code, 0, first.stderr.toString())
    const next = await pairLocal(directory, stand.origin, 'sha256:' + 'b'.repeat(64))
    assert.equal(next.code, 0, next.stderr.toString())
    const [paired, replaced] = stand.requests
    assert.equal(replaced.nodeId, paired.nodeId)
    assert.equal(replaced.token, paired.token)
    assert.equal(replaced.capabilities.protocol, 2)
    assert.equal(replaced.capabilities.image, 'sha256:' + 'b'.repeat(64))
    const state = await openNodeState(join(directory, 'state'))
    try { assert.deepEqual(state.connection(stand.origin), { server: stand.origin, nodeId: paired.nodeId, serverId, token: paired.token }) }
    finally { state.close() }
  } finally { stand.server.close(); await rm(directory, { recursive: true, force: true }) }
})

test('a revoked local Node stays off and is not paired again as another Node', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'l4-pair-revoked-'))
  const serverId = randomUUID()
  let revoked = false
  const stand = await localServer(() => revoked ? { status: 409, json: {} } : { status: 200, json: { serverId } })
  try {
    assert.equal((await pairLocal(directory, stand.origin, 'sha256:' + 'a'.repeat(64))).code, 0)
    revoked = true
    const refused = await pairLocal(directory, stand.origin, 'sha256:' + 'b'.repeat(64))
    assert.notEqual(refused.code, 0)
    assert.match(refused.stderr.toString(), /disabled and revoked in Server settings/u)
    assert.equal(stand.requests.length, 2)
    assert.equal(stand.requests[1].nodeId, stand.requests[0].nodeId)
  } finally { stand.server.close(); await rm(directory, { recursive: true, force: true }) }
})
