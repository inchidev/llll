import { z } from 'zod'
import { dockerCapabilities, type ComputeNode } from '../../shared/software-factory'
import { L4_COMPUTE_NODE_NAME } from '../../shared/l4-compute'
import { confirmL4Boxes, releaseL4Boxes } from './l4-compute'
import type { AuthorizationContext } from '../../shared/authorization'
import { newId, nowIso } from '../../shared/ids'
import type { L4Env } from '../../workers/env'
import { getServerId } from '../../shared/server-id'
import { factoryHash } from './factory-authority'
import { computePublish, expireApprovals, publishedApproval } from './factory-approvals'
import { githubSourceGrant } from './github-agent-client'
import { giteaCredentials } from './gitea'
import { requireArtifacts } from './factory-artifacts'
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
  // A released L4 Compute box's Node is gone for good; only boxes still running are listed under their placement.
  const rows = await env.DB.prepare('SELECT id,name,enabled,capabilities_json AS capabilitiesJson,last_seen AS lastSeen,placement_id AS placementId,box_id AS boxId FROM compute_nodes WHERE placement_id IS NULL OR enabled=1 ORDER BY created_at')
    .all<{ id: string; name: string; enabled: number; capabilitiesJson: string; lastSeen: string | null; placementId: string | null; boxId: string | null }>()
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
/**
 * A Node redeems its one-use pairing code. A code minted for an L4 Compute box makes that box's own Node under
 * the Server's placement and moves the box to it; from then on the box is an ordinary Node's (ADR 0009).
 */
export async function pairComputeNode(env: L4Env, token: string, capabilities: z.infer<typeof dockerCapabilities>) {
  const parsed = dockerCapabilities.parse(capabilities), id = newId(), credential = secret()
  const pairing = await env.DB.prepare('DELETE FROM compute_pairings WHERE token_hash=? AND expires_at>? RETURNING name,created_by AS createdBy,box_id AS boxId').bind(await factoryHash(token), nowIso()).first<{ name: string; createdBy: string; boxId: string | null }>()
  if (!pairing) fail(403, 'compute_pairing_invalid', 'Pairing is unavailable or expired')
  if (!pairing.boxId) {
    await env.DB.prepare('INSERT INTO compute_nodes(id,name,token_hash,capabilities_json,last_seen,created_by,created_at) VALUES(?,?,?,?,?,?,?)')
      .bind(id, pairing.name, await factoryHash(credential), JSON.stringify(parsed), nowIso(), pairing.createdBy, nowIso()).run()
    return { nodeId: id, token: credential, serverId: await getServerId(env.DB) }
  }
  const box = await env.DB.prepare(`SELECT b.id,b.node_id AS nodeId,n.placement_id AS placementId,t.title FROM factory_boxes b JOIN compute_nodes n ON n.id=b.node_id JOIN tasks t ON t.id=b.task_id
    WHERE b.id=? AND b.status<>'released'`).bind(pairing.boxId).first<{ id: string; nodeId: string; placementId: string | null; title: string }>()
  if (!box) fail(409, 'compute_box_released', 'This box was released before its Node paired')
  const placementId = box.placementId ?? box.nodeId
  await env.DB.batch([
    env.DB.prepare('INSERT INTO compute_nodes(id,name,token_hash,capabilities_json,last_seen,created_by,created_at,placement_id,box_id) VALUES(?,?,?,?,?,?,?,?,?)')
      .bind(id, `${L4_COMPUTE_NODE_NAME} · ${box.title}`.slice(0, 80), await factoryHash(credential), JSON.stringify(parsed), nowIso(), pairing.createdBy, nowIso(), placementId, box.id),
    // A box paired again (its earlier Node is gone) leaves that Node revoked.
    env.DB.prepare('UPDATE compute_nodes SET enabled=0,token_hash=? WHERE box_id=? AND id<>?').bind(await factoryHash(secret()), box.id, id),
    env.DB.prepare('UPDATE factory_boxes SET node_id=?,updated_at=? WHERE id=?').bind(id, nowIso(), box.id),
  ])
  // llll.gg destroys a box it has not seen confirmed within ten minutes; a confirmation that fails now is tried on the Node's syncs.
  await confirmL4Boxes(env, [box.id])
  return { nodeId: id, token: credential, serverId: await getServerId(env.DB) }
}
export async function disableComputeNode(env: L4Env, auth: AuthorizationContext, id: string) {
  requireComputeOwner(auth)
  // An L4 Compute box's Node goes with its box: llll.gg stops billing it.
  const boxed = await env.DB.prepare('SELECT box_id AS boxId FROM compute_nodes WHERE id=? AND box_id IS NOT NULL').bind(id).first<{ boxId: string }>()
  if (boxed) await releaseL4Boxes(env, [boxed.boxId])
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
  if (environment.provider === 'gitea' || environment.provider === 'artifacts') {
    // The credential stays on the Server: the Node fetches through it.
    if (environment.provider === 'gitea') await giteaCredentials(env, environment.gitConnectionId)
    else requireArtifacts(env)
    let origin: string
    try { origin = new URL(env.PUBLIC_ORIGIN || '').origin } catch { fail(409, 'compute_source', 'Configure this Server’s public origin before fetching source through it') }
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
