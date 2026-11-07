// Trusted host bootstrap. This program never runs in a Task container.
import { readFile } from 'node:fs/promises'
import { createHmac } from 'node:crypto'
import { openNodeState, serverOrigin } from './state-store.mjs'
import { nodeCapacity } from './capacity.mjs'

process.umask(0o077)
const config = Object.fromEntries((await readFile(process.argv[2], 'utf8')).split('\n').filter(line => /^(AUTH_SECRET|PUBLIC_ORIGIN|SERVER_ID)=/u.test(line)).map(line => {
  const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1).replace(/^'|'$/gu, '')]
}))
const origin = serverOrigin(process.env.LLLL_SERVER_ORIGIN)
if (serverOrigin(config.PUBLIC_ORIGIN) !== origin) throw new Error('Local pairing origin does not match the operator-selected Server')
const diskBytes = Number(process.env.LLLL_WORKSPACE_DISK_BYTES || 10737418240)
const state = await openNodeState(process.env.LLLL_NODE_STATE)
try {
  // Every start says what this Node runs now. A paired Node signs with its own credential, so an update
  // from a release replaces its daemon and box image in place: the same Node, its boxes and their disks.
  const paired = state.connection(origin)
  const capabilities = { diskBytes, docker: true, durableDisk: true, isolation: 'shared-kernel', image: process.env.LLLL_WORKSPACE_IMAGE, capacity: nodeCapacity(), protocol: 2 }
  const { nodeId, token } = paired ?? state.localPairing(origin)
  const body = JSON.stringify({ nodeId, token, capabilities, timestamp: Date.now() })
  const signature = createHmac('sha256', config.AUTH_SECRET).update('l4-local-compute-v1\n' + origin + '\n' + body).digest('hex')
  const response = await fetch(origin + '/api/compute-agent/local-pair', { method: 'POST', redirect: 'error',
    headers: { 'Content-Type': 'application/json', 'X-L4-Local-Signature': signature }, body, signal: AbortSignal.timeout(15000) })
  if (!response.ok) {
    if (paired && response.status === 409) throw new Error('This local Compute Node was disabled and revoked in Server settings → Compute, so it stays off. Its Task disks are kept in LLLL_NODE_STATE.')
    throw new Error(response.status === 409 ? 'Claim the Server Owner before enabling local Factory. The service will retry.' : 'Local Factory pairing failed; verify this installation and its Server origin.')
  }
  const { serverId } = await response.json()
  if ((config.SERVER_ID && serverId !== config.SERVER_ID) || (paired && serverId !== paired.serverId)) throw new Error('Local Factory Server UUID mismatch')
  if (!paired) state.pair(origin, { serverId, nodeId, token })
} finally { state.close() }
