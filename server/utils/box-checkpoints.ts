import { z } from 'zod'
import type { RunEnvironment } from '../../shared/code-environments'
import { nowIso } from '../../shared/ids'
import { getServerId } from '../../shared/server-id'
import { factoryRepositoryName } from '../../shared/software-factory'
import type { L4Env } from '../../workers/env'
import { fail } from './cf'
import { artifactsTransport, requireArtifacts, withRepository } from './factory-artifacts'
import { leaseCapability, sameCapability } from './factory-boxes'

/**
 * An L4 Compute box's checkpoint (ADR 0011, 0013): the Task disk's checkout, saved to a private Artifacts
 * repository of its own, in the format a Cloudflare box uses (`l4-state`, packages/compute-node/src/cloud-io.mjs),
 * so that an idle box can give its machine back and a new machine continues where it stopped.
 *
 * Every credential stays on this Server. The box's daemon fetches and pushes through
 * `/api/compute-agent/checkpoint/<box>.git` with a capability bound to the box and its lease, and this Server adds
 * a token minted for each request, as it does for a Project's repository in L4. A push may update `l4-state` and
 * nothing else; the checkpoint counts only once this Server has read it back from Artifacts.
 */
const SHA = /^[a-f0-9]{40}$/u
const ACTIVE = "('starting','running','idle')"
const lease = z.string().regex(/^[a-f0-9]{64}$/u)
export const boxCheckpointInput = z.object({ operation: z.literal('checkpoint'), boxId: z.string().uuid(), lease }).strict()
export const boxCheckpointedInput = z.object({ operation: z.literal('checkpointed'), boxId: z.string().uuid(), lease, checkpoint: z.string().regex(SHA), head: z.string().regex(SHA) }).strict()

export const boxCheckpointRepository = async (env: L4Env, boxId: string) => factoryRepositoryName(await getServerId(env.DB), boxId)
export const checkpointCapability = (env: L4Env, boxId: string, lease: string) => leaseCapability(env, 'compute-checkpoint', boxId, lease)

type LeasedL4Box = { id: string; taskId: string; environmentJson: string; checkpointSha: string | null; leaseToken: string }
/** A box on its own L4 Compute Node, under the lease that Node holds now. Only such a box is checkpointed. */
export async function leasedL4Box(env: L4Env, boxId: string, lease: string, nodeId?: string) {
  return await env.DB.prepare(`SELECT b.id,b.task_id AS taskId,b.environment_json AS environmentJson,b.checkpoint_sha AS checkpointSha,b.lease_token AS leaseToken FROM factory_boxes b
    JOIN compute_nodes n ON n.id=b.node_id AND n.enabled=1 AND n.placement_id IS NOT NULL
    WHERE b.id=? AND (? IS NULL OR b.node_id=?) AND b.lease_token=? AND b.lease_until>? AND b.status IN ${ACTIVE}`)
    .bind(boxId, nodeId ?? null, nodeId ?? null, lease, nowIso()).first<LeasedL4Box>()
}

function checkpointRemote(env: L4Env, boxId: string) {
  let origin: string
  try { origin = new URL(env.PUBLIC_ORIGIN || '').origin } catch { fail(409, 'compute_checkpoint', 'Configure this Server’s public origin before saving a box through it') }
  return `${origin}/api/compute-agent/checkpoint/${boxId}.git`
}

/**
 * The daemon is about to save an idle box: where to push, and what the last acknowledged checkpoint was, which
 * the new one names as a parent. A box with none yet gets a fresh repository; one left by a save that was never
 * acknowledged holds nothing acknowledged, so it goes first, as on Cloudflare.
 */
export async function computeCheckpoint(env: L4Env, nodeId: string, input: z.infer<typeof boxCheckpointInput>) {
  const box = await leasedL4Box(env, input.boxId, input.lease, nodeId)
  if (!box) fail(403, 'box_checkpoint_denied', 'This box holds no lease on its L4 Compute Node')
  const code = requireArtifacts(env), name = await boxCheckpointRepository(env, box.id)
  if (!box.checkpointSha) {
    const options = { description: `L4 private Task ${box.taskId}`, setDefaultBranch: 'l4-state' }
    let created: Awaited<ReturnType<typeof code.create>>
    try { created = await code.create(name, options) }
    catch { await code.delete(name).catch(() => undefined); created = await code.create(name, options) }
    await withRepository(env, name, repo => repo.revokeToken(created.token)).catch(() => undefined)
  }
  return { remote: checkpointRemote(env, box.id), authorization: `Bearer ${await checkpointCapability(env, box.id, input.lease)}`,
    baseSha: (JSON.parse(box.environmentJson) as RunEnvironment).baseSha, previous: box.checkpointSha }
}

/**
 * The daemon pushed a checkpoint. It counts once `l4-state` in Artifacts is at it and its first parent is the head
 * the daemon names, as a checkpoint's is; only then may the idle box give its machine back.
 */
export async function computeCheckpointed(env: L4Env, nodeId: string, input: z.infer<typeof boxCheckpointedInput>) {
  const box = await leasedL4Box(env, input.boxId, input.lease, nodeId)
  if (!box) fail(403, 'box_checkpoint_denied', 'This box holds no lease on its L4 Compute Node')
  const verified = await withRepository(env, await boxCheckpointRepository(env, box.id), async repo => {
    const [head] = await repo.log({ ref: 'l4-state', limit: 1 })
    const saved = head?.hash === input.checkpoint ? await repo.readCommit(input.checkpoint) : null
    return Boolean(saved && saved.parents.length >= 2 && saved.parents.length <= 3 && saved.parents[0] === input.head)
  }).catch(() => false)
  if (!verified) fail(409, 'box_checkpoint_unverified', 'The checkpoint is not what the box’s repository holds')
  await env.DB.prepare('UPDATE factory_boxes SET checkpoint_sha=?,head_sha=?,updated_at=? WHERE id=? AND lease_token=?').bind(input.checkpoint, input.head, nowIso(), box.id, input.lease).run()
  return { ok: true }
}

/**
 * A box starting on a new machine continues from its checkpoint, never from the pinned source: the grant names the
 * acknowledged commit and the read address. Null when the box has no checkpoint or is not on L4 Compute.
 */
export async function checkpointRestore(env: L4Env, nodeId: string, boxId: string, lease: string) {
  const box = await leasedL4Box(env, boxId, lease, nodeId)
  if (!box?.checkpointSha) return null
  requireArtifacts(env)
  return { checkpoint: box.checkpointSha, source: { remote: checkpointRemote(env, box.id), authorization: `Bearer ${await checkpointCapability(env, box.id, lease)}` } }
}

/** The Git transport behind the checkpoint address: a fetch of the repository, or a push of `l4-state` only. */
export async function checkpointTransport(env: L4Env, boxId: string, presented: string, suffix: string, incoming: Request) {
  const box = await env.DB.prepare(`SELECT b.lease_token AS leaseToken FROM factory_boxes b JOIN compute_nodes n ON n.id=b.node_id AND n.enabled=1 AND n.placement_id IS NOT NULL
    WHERE b.id=? AND b.lease_token IS NOT NULL AND b.lease_until>? AND b.status IN ${ACTIVE}`).bind(boxId, nowIso()).first<{ leaseToken: string }>()
  if (!box || !sameCapability(presented, await checkpointCapability(env, boxId, box.leaseToken))) return new Response('Checkpoint capability expired', { status: 403 })
  const service = suffix === '/git-receive-pack' || new URL(incoming.url).searchParams.get('service') === 'git-receive-pack' ? 'git-receive-pack' : 'git-upload-pack'
  const repository = { sourceRepo: await boxCheckpointRepository(env, boxId), remote: null }
  return service === 'git-receive-pack'
    ? artifactsTransport(env, repository, suffix, incoming, { service, expected: { ref: 'refs/heads/l4-state', sha: null } })
    : artifactsTransport(env, repository, suffix, incoming, { service })
}

/** A released box's checkpoint goes with it: only a release removes Task code. */
export async function deleteBoxCheckpoints(env: L4Env, boxIds: string[]) {
  if (!env.FACTORY_CODE || !boxIds.length) return
  for (const boxId of boxIds) await env.FACTORY_CODE.delete(await boxCheckpointRepository(env, boxId)).catch(() => undefined)
}

/** Whether a sync tells this Node's boxes to save themselves when idle: a box's own L4 Compute Node, on a Server with Artifacts. */
export const checkpointsIdleBoxes = (env: L4Env, node: { placementId: string | null }) => Boolean(node.placementId && env.FACTORY_CODE)
