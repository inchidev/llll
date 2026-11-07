import { z } from 'zod'
import { dockerCapabilities, type ComputeNode } from '../../shared/software-factory'
import type { AuthorizationContext } from '../../shared/authorization'
import { newId, nowIso } from '../../shared/ids'
import type { L4Env } from '../../workers/env'
import { getServerId } from '../../shared/server-id'
import { factoryHash } from './factory-authority'
import { computePublish, expireApprovals, publishedApproval } from './factory-approvals'
import { githubSourceGrant } from './github-agent-client'
import { giteaCredentials } from './gitea'
import { fail } from './cf'
import { boxSecretsInput, boxSourceInput, boxSyncInput, boxTurnInput, computeSecrets, computeSync, computeTurn, leaseCapability, leasedBox } from './factory-boxes'
import type { RunEnvironment } from '../../shared/code-environments'

/** A Gitea token never reaches a Node. The Node fetches through this Server with a capability bound to
 * the box and its lease, so it ends with the lease. */
export async function computeSourceCapability(env: L4Env, boxId: string, lease: string) {
  return leaseCapability(env, 'compute-source', boxId, lease)
}
const secret = () => [...crypto.getRandomValues(new Uint8Array(32))].map(byte => byte.toString(16).padStart(2, '0')).join('')
export function requireComputeOwner(auth: AuthorizationContext) {
  if (auth.principal.kind !== 'human' || !auth.principal.isOwner || auth.credential.kind !== 'session' || auth.delegation) fail(403, 'compute_denied', 'Compute administration needs a human Owner session')
}
export async function listComputeNodes(env: L4Env, auth: AuthorizationContext): Promise<ComputeNode[]> {
  requireComputeOwner(auth)
  const rows = await env.DB.prepare('SELECT id,name,enabled,capabilities_json AS capabilitiesJson,last_seen AS lastSeen FROM compute_nodes ORDER BY created_at').all<{ id: string; name: string; enabled: number; capabilitiesJson: string; lastSeen: string | null }>()
  return rows.results.map(({ enabled, capabilitiesJson, ...row }) => ({ ...row, enabled: Boolean(enabled), capabilities: JSON.parse(capabilitiesJson) }))
}
export async function prepareComputePairing(env: L4Env, auth: AuthorizationContext, name: string) {
  requireComputeOwner(auth)
  z.string().trim().min(1).max(80).parse(name)
  await env.DB.prepare('DELETE FROM compute_pairings WHERE expires_at<=?').bind(nowIso()).run()
  const token = secret(), expiresAt = new Date(Date.now() + 10 * 60000).toISOString()
  const inserted = await env.DB.prepare('INSERT INTO compute_pairings(token_hash,name,created_by,expires_at) SELECT ?,?,?,? WHERE (SELECT count(*) FROM compute_pairings)<10 RETURNING token_hash').bind(await factoryHash(token), name.trim(), auth.principal.id, expiresAt).first()
  if (!inserted) fail(429, 'compute_pairing_limit', 'Pairing limit reached')
  return { token, expiresAt }
}
export async function pairComputeNode(env: L4Env, token: string, capabilities: z.infer<typeof dockerCapabilities>) {
  const parsed = dockerCapabilities.parse(capabilities), id = newId(), credential = secret()
  const pairing = await env.DB.prepare('DELETE FROM compute_pairings WHERE token_hash=? AND expires_at>? RETURNING name,created_by AS createdBy').bind(await factoryHash(token), nowIso()).first<{ name: string; createdBy: string }>()
  if (!pairing) fail(403, 'compute_pairing_invalid', 'Pairing is unavailable or expired')
  await env.DB.prepare('INSERT INTO compute_nodes(id,name,token_hash,capabilities_json,last_seen,created_by,created_at) VALUES(?,?,?,?,?,?,?)')
    .bind(id, pairing.name, await factoryHash(credential), JSON.stringify(parsed), nowIso(), pairing.createdBy, nowIso()).run()
  return { nodeId: id, token: credential, serverId: await getServerId(env.DB) }
}
export async function disableComputeNode(env: L4Env, auth: AuthorizationContext, id: string) {
  requireComputeOwner(auth)
  await env.DB.batch([
    env.DB.prepare('UPDATE compute_nodes SET enabled=0,token_hash=? WHERE id=?').bind(await factoryHash(secret()), id),
    // A removed Node pushes nothing more; a push it had begun may have happened.
    env.DB.prepare(`UPDATE factory_approvals SET status=CASE WHEN status='publishing' THEN 'uncertain' ELSE 'expired' END
      WHERE box_id IN (SELECT id FROM factory_boxes WHERE node_id=?) AND status IN ('pending_diff','pending','approved','publishing') AND kind<>'plan'`).bind(id),
  ])
}
export async function requireComputeNode(env: L4Env, credential: string) {
  // One round trip finds the Node and records that it was seen.
  const node = await env.DB.prepare('UPDATE compute_nodes SET last_seen=? WHERE token_hash=? AND enabled=1 RETURNING id,capabilities_json AS capabilitiesJson').bind(nowIso(), await factoryHash(credential)).first<{ id: string; capabilitiesJson: string }>()
  if (!node) fail(403, 'compute_revoked', 'Compute Node authorization unavailable')
  return node
}
const approvalId = z.string().uuid()
export const computePollSchema = z.discriminatedUnion('operation', [
  // Node protocol 2: a Node syncs its boxes, fetches their turns and source, and pushes what was approved.
  boxSyncInput,
  boxTurnInput,
  boxSourceInput,
  boxSecretsInput,
  z.object({ operation: z.literal('publish'), approvalId }).strict(),
  z.object({ operation: z.literal('published'), approvalId, ok: z.boolean(), message: z.string().max(500).optional() }).strict(),
])
/**
 * A box's first start fetches the Task's pinned source, as a bootstrap did: GitHub gives the Node's trusted
 * fetch broker a single-repository read token, which it revokes after use; for Gitea the Node fetches through
 * this Server with a capability bound to the box and its lease. Either ends with the lease.
 */
export async function computeBoxSource(env: L4Env, nodeId: string, input: z.infer<typeof boxSourceInput>) {
  const box = await leasedBox(env, input.boxId, input.lease, nodeId)
  if (!box) fail(403, 'box_source_denied', 'This box holds no lease for a running turn')
  const environment = JSON.parse(box.environmentJson) as RunEnvironment
  const pinned = { id: box.id, repository: environment.sourceRepo, baseSha: environment.baseSha }
  if (environment.provider === 'gitea') {
    await giteaCredentials(env, environment.gitConnectionId)
    let origin: string
    try { origin = new URL(env.PUBLIC_ORIGIN || '').origin } catch { fail(409, 'compute_source', 'Configure this Server’s public origin before fetching Gitea source') }
    return { ...pinned, source: { remote: `${origin}/api/compute-agent/source/${box.id}.git`, authorization: `Bearer ${await computeSourceCapability(env, box.id, input.lease)}` } }
  }
  const sourceToken = await githubSourceGrant(env, { connectionId: environment.gitConnectionId, installationId: environment.sourceInstallationId, repositoryId: environment.sourceRepoId }, async () => {
    if (!await leasedBox(env, input.boxId, input.lease, nodeId)) fail(403, 'box_source_denied', 'This box holds no lease for a running turn')
  })
  return { ...pinned, sourceToken }
}
export async function computePoll(env: L4Env, nodeId: string, input: z.infer<typeof computePollSchema>) {
  if (input.operation === 'sync') return computeSync(env, nodeId, input)
  if (input.operation === 'turn') return computeTurn(env, nodeId, input)
  if (input.operation === 'source') return computeBoxSource(env, nodeId, input)
  if (input.operation === 'secrets') return computeSecrets(env, nodeId, input)
  await expireApprovals(env)
  if (input.operation === 'publish') return computePublish(env, nodeId, input.approvalId)
  return publishedApproval(env, nodeId, input.approvalId, input)
}
