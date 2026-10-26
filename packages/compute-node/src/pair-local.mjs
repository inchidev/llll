// Trusted host bootstrap. This program never runs in a Task container.
import { readFile, writeFile, unlink } from 'node:fs/promises'
import { createHmac, randomBytes } from 'node:crypto'
import { openNodeState, serverOrigin } from './state-store.mjs'

process.umask(0o077)
const config = Object.fromEntries((await readFile(process.argv[2], 'utf8')).split('\n').filter(line => /^(AUTH_SECRET|PUBLIC_ORIGIN|SERVER_ID)=/u.test(line)).map(line => {
  const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1).replace(/^'|'$/gu, '')]
}))
const origin = serverOrigin(config.PUBLIC_ORIGIN)
const state = await openNodeState(process.env.LLLL_NODE_STATE)
try {
  if (!state.connection(origin)) {
    const capabilities = { diskBytes: 1073741824, docker: true, durableDisk: true, isolation: 'shared-kernel', image: process.env.LLLL_WORKSPACE_IMAGE, maxParallel: 1, protocol: 1 }
    const intentFile = process.env.LLLL_NODE_STATE + '/local-pair.json'
    let intent
    try { intent = JSON.parse(await readFile(intentFile, 'utf8')) } catch (error) { if (error.code !== 'ENOENT') throw error }
    intent ??= { nodeId: crypto.randomUUID(), token: randomBytes(32).toString('hex'), origin }
    if (intent.origin !== origin || !/^[a-f0-9-]{36}$/u.test(intent.nodeId) || !/^[a-f0-9]{64}$/u.test(intent.token)) throw new Error('Local pairing identity mismatch')
    await writeFile(intentFile, JSON.stringify(intent), { mode: 0o600, flush: true })
    const { nodeId, token } = intent
    const body = JSON.stringify({ nodeId, token, capabilities, timestamp: Date.now() })
    const signature = createHmac('sha256', config.AUTH_SECRET).update('l4-local-compute-v1\n' + origin + '\n' + body).digest('hex')
    const response = await fetch(origin + '/api/compute-agent/local-pair', { method: 'POST', redirect: 'error',
      headers: { 'Content-Type': 'application/json', 'X-L4-Local-Signature': signature }, body, signal: AbortSignal.timeout(15000) })
    if (!response.ok) throw new Error(response.status === 409 ? 'Claim the Server Owner before enabling local Factory. The service will retry.' : 'Local Factory pairing failed; verify this installation and its Server origin.')
    const { serverId } = await response.json()
    if (config.SERVER_ID && serverId !== config.SERVER_ID) throw new Error('Local Factory Server UUID mismatch')
    state.pair(origin, { serverId, nodeId, token })
    await unlink(intentFile)
  }
} finally { state.close() }
