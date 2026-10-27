import { z } from 'zod'
import { dockerCapabilities } from '../../shared/software-factory'
import type { L4Env } from '../../workers/env'
import { computePoll, computePollSchema, pairComputeNode, requireComputeNode } from './compute-nodes'
import { readLimitedStream } from '../../workers/inbound-email-signature'
import { fail } from './cf'

const jobSchema = z.object({ id: z.string().uuid(), path: z.enum(['/api/compute-agent/pair', '/api/compute-agent/poll']), authorization: z.string().max(128).nullable(), body: z.string().max(500000) }).strict()
const pairSchema = z.object({ token: z.string().regex(/^[a-f0-9]{64}$/u), capabilities: dockerCapabilities }).strict()
export type LizardBridgeConnection = { hostname: string; accessToken: string; relayKey: string }
function bridgeOrigin(connection: LizardBridgeConnection) {
  if (!/^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.onlizard\.com$/u.test(connection.hostname) || !connection.accessToken || !/^[a-f0-9]{64}$/u.test(connection.relayKey)) fail(400, 'lizard_bridge_invalid', 'Invalid Lizard bridge identity')
  return `https://${connection.hostname}`
}
/** Handle one authenticated relay request. No user-selected URLs or ambient browser credentials are forwarded. */
export async function serviceLizardBridge(env: L4Env, connection: LizardBridgeConnection, expectedNodeId?: string, persistPairedNode?: (nodeId: string) => Promise<void>) {
  const origin = bridgeOrigin(connection), headers = { 'X-Lizard-Access-Token': connection.accessToken, 'X-Relay-Key': connection.relayKey }
  const next = await fetch(origin + '/bridge/next', { headers, redirect: 'error', signal: AbortSignal.timeout(10000) })
  if (!next.ok) fail(503, 'lizard_bridge_unavailable', 'Lizard compute bridge is unavailable')
  const bytes = await readLimitedStream(next.body, 600000)
  if (!bytes.ok) fail(503, 'lizard_bridge_invalid', 'Lizard compute request exceeded its limit')
  let job: z.infer<typeof jobSchema> | null
  try { job = z.union([jobSchema, z.null()]).parse(JSON.parse(new TextDecoder().decode(bytes.bytes))) }
  catch { fail(503, 'lizard_bridge_invalid', 'Lizard compute request was invalid') }
  if (!job) return { processed: false as const }
  let status = 200, payload: unknown, nodeId: string | undefined
  try {
    const input = JSON.parse(job.body)
    if (job.path === '/api/compute-agent/pair') {
      if (expectedNodeId) fail(403, 'lizard_bridge_pair_denied', 'This compute node is already paired')
      if (!persistPairedNode) fail(503, 'lizard_pair_persistence', 'Compute pairing persistence is unavailable')
      const pair = pairSchema.parse(input)
      if (pair.capabilities.provider !== 'lizard') fail(403, 'lizard_bridge_pair_denied', 'Compute provider identity does not match')
      payload = await pairComputeNode(env, pair.token, pair.capabilities)
      nodeId = (payload as { nodeId: string }).nodeId
      // Record ownership before returning the credential to the VM, so a lost
      // response cannot leave a billable Node unknown to cleanup.
      await persistPairedNode(nodeId)
    } else {
      const credential = /^Bearer ([a-f0-9]{64})$/u.exec(job.authorization ?? '')?.[1]
      if (!credential) fail(403, 'compute_revoked', 'Compute Node authorization unavailable')
      const node = await requireComputeNode(env, credential, 'lizard')
      if (!expectedNodeId || node.id !== expectedNodeId) fail(403, 'lizard_bridge_node_denied', 'Compute Node does not match this bridge')
      payload = await computePoll(env, node.id, computePollSchema.parse(input))
    }
  } catch (error) {
    status = error && typeof error === 'object' && 'statusCode' in error ? Number(error.statusCode) : 400
    if (!Number.isInteger(status) || status < 400 || status > 599) status = 500
    payload = { error: { code: 'lizard_compute_request_failed', message: 'Compute request was rejected' } }
  }
  const response = await fetch(origin + '/bridge/respond', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(10000), body: JSON.stringify({ id: job.id, status, body: JSON.stringify(payload) }) })
  if (!response.ok) fail(503, 'lizard_bridge_delivery_uncertain', 'Compute response delivery is uncertain; inspect the Node before retrying')
  return { processed: true as const, accepted: status < 400, ...(status < 400 && nodeId ? { nodeId } : {}) }
}
