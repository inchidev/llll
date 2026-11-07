import { z } from 'zod'
import type { AgentRun, RunMandate, RuntimeEvent } from '../../shared/agent-execution'
import { runtimeEventSchema } from '../../shared/agent-execution'
import type { RunEnvironment } from '../../shared/code-environments'
import { computeCapabilities, nodeCapacity, type ComputeCapabilities } from '../../shared/software-factory'
import { newId, nowIso } from '../../shared/ids'
import { asRpc, type L4Env } from '../../workers/env'
import { fanoutAgentTurns, patchAgentTurn } from '../../workers/agent-turns'
import { admitBoxes, BOX_WAITING_DETAIL } from './box-admission'
import { fail } from './cf'
import { boxOutwardWork, OPEN_APPROVALS } from './factory-approvals'

/** A Node renews every box it lists on each sync; one that misses a minute of syncs loses its lease and its share. */
export const BOX_LEASE_MS = 60000
const ACTIVE = "('starting','running','idle')"
const secret = () => [...crypto.getRandomValues(new Uint8Array(32))].map(byte => byte.toString(16).padStart(2, '0')).join('')
const leaseUntil = () => new Date(Date.now() + BOX_LEASE_MS).toISOString()

/**
 * A bearer capability for a trusted component of a Node, bound to one purpose, one box or approval and the
 * box's current lease: it ends with the lease. Gitea credentials stay on the Server behind it.
 */
export async function leaseCapability(env: L4Env, purpose: 'compute-source' | 'compute-publish', id: string, lease: string) {
  if (!env.AUTH_SECRET || env.AUTH_SECRET.length < 32) fail(503, 'compute_source', 'Server credential encryption is unavailable')
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.AUTH_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return [...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${purpose}:${id}:${lease}`)))].map(byte => byte.toString(16).padStart(2, '0')).join('')
}
/** Compares a presented bearer capability with the expected one in constant time. */
export function sameCapability(presented: string, expected: string) {
  let difference = presented.length ^ 64
  for (let index = 0; index < 64; index++) difference |= (presented.charCodeAt(index) || 0) ^ (expected.charCodeAt(index) || 0)
  return Boolean(expected) && !difference
}

export type FactoryBox = { id: string; channelId: string; taskId: string; agentId: string; initiatedBy: string; nodeId: string; environmentJson: string; originRunId: string
  runId: string | null; status: string; leaseToken: string | null; leaseUntil: string | null; cpu: number | null; memoryMib: number | null; runtimeMs: number; updatedAt: string }
const boxColumns = `id,channel_id AS channelId,task_id AS taskId,agent_id AS agentId,initiated_by AS initiatedBy,node_id AS nodeId,environment_json AS environmentJson,origin_run_id AS originRunId,
  run_id AS runId,status,lease_token AS leaseToken,lease_until AS leaseUntil,cpu,memory_mib AS memoryMib,runtime_ms AS runtimeMs,updated_at AS updatedAt`

/** What the box's own Run executor reports to the Run's Durable Object, through the gateway. */
export const boxEventsRequest = z.object({ from: z.number().int().min(0).max(1000000), events: z.array(runtimeEventSchema).max(100),
  result: runtimeEventSchema.refine(event => event.type === 'result' || event.type === 'error', 'A result ends the turn').optional() }).strict()
export type BoxEventsAck = { ack: number; cancel: boolean; steer: Array<{ messageId: string; content: string }> }
export type BoxRunRpc = {
  boxEvents: (runId: string, from: number, events: RuntimeEvent[], result?: RuntimeEvent) => Promise<BoxEventsAck | null>
  boxSession: (runId: string, transcript: string) => Promise<boolean>
  boxSubmission: (runId: string) => Promise<unknown>
}
export const boxRun = (env: L4Env, runId: string) => {
  if (!env.AGENT_RUN_DO) fail(503, 'box_unavailable', 'Run coordination is unavailable')
  return asRpc<BoxRunRpc>(env.AGENT_RUN_DO.getByName(`run:${runId}`))
}

export const boxSyncInput = z.object({ operation: z.literal('sync'),
  capacity: z.object({ ...nodeCapacity.shape, diskFree: z.number().int().min(0) }).strict(),
  boxes: z.array(z.object({ id: z.string().uuid(), lease: z.string().regex(/^[a-f0-9]{64}$/u), state: z.enum(['starting', 'running', 'idle', 'stopped', 'failed']),
    runId: z.string().uuid().optional(), runtimeMs: z.number().int().min(0).max(1e12) }).strict()).max(64) }).strict()
export const boxTurnInput = z.object({ operation: z.literal('turn'), boxId: z.string().uuid(), lease: z.string().regex(/^[a-f0-9]{64}$/u), runId: z.string().uuid() }).strict()
export const boxSourceInput = z.object({ operation: z.literal('source'), boxId: z.string().uuid(), lease: z.string().regex(/^[a-f0-9]{64}$/u) }).strict()

/**
 * A box its Node holds under a live lease, while its Run's turn is running: what a source fetch needs.
 * Without a Node, any Node holding the box may ask, as the Server's own source address does.
 */
export async function leasedBox(env: L4Env, boxId: string, lease: string, nodeId?: string) {
  return await env.DB.prepare(`SELECT b.id,b.node_id AS nodeId,b.environment_json AS environmentJson FROM factory_boxes b JOIN agent_runs r ON r.id=b.run_id
    WHERE b.id=? AND (? IS NULL OR b.node_id=?) AND b.lease_token=? AND b.lease_until>? AND b.status IN ${ACTIVE} AND r.status='running'`)
    .bind(boxId, nodeId ?? null, nodeId ?? null, lease, nowIso()).first<{ id: string; nodeId: string; environmentJson: string }>()
}

/**
 * The Node a Run's box lives on: a Task Run with computer access whose repository names a Node that runs
 * boxes. A paired Node syncs them itself; on Cloudflare each box's own Durable Object does, so this Server
 * must have its container binding.
 */
export async function boxNodeFor(env: L4Env, run: Pick<AgentRun, 'taskId' | 'environmentJson' | 'mandateJson'>): Promise<{ nodeId: string; capabilities: ComputeCapabilities } | null> {
  if (!run.taskId || !run.environmentJson || !(JSON.parse(run.mandateJson) as RunMandate).computer) return null
  const nodeId = (JSON.parse(run.environmentJson) as RunEnvironment).computeNodeId
  if (!nodeId) return null
  const node = await env.DB.prepare('SELECT capabilities_json AS capabilitiesJson FROM compute_nodes WHERE id=? AND enabled=1').bind(nodeId).first<{ capabilitiesJson: string }>()
  const capabilities = node ? computeCapabilities.safeParse(JSON.parse(node.capabilitiesJson)) : null
  if (!capabilities?.success || ('provider' in capabilities.data && !env.FACTORY_COMPUTE)) return null
  return { nodeId, capabilities: capabilities.data }
}

/** The Durable Object that runs a box on Cloudflare: one per box, so a Task's container is always its own. */
export const cloudBoxName = (boxId: string) => `box:${boxId}`
export type CloudBoxRpc = { wake: (boxId: string) => Promise<void> }

/**
 * Asks a Cloudflare box to look at what the Server wants of it now: a turn handed to it, a cancellation,
 * room on its Node or its release. A box on a paired Node hears the same on its Node's next sync.
 */
export async function wakeCloudBox(env: L4Env, boxId: string) {
  if (!env.FACTORY_COMPUTE) return
  const cloud = await env.DB.prepare("SELECT 1 FROM factory_boxes b JOIN compute_nodes n ON n.id=b.node_id WHERE b.id=? AND json_extract(n.capabilities_json,'$.provider')='cloudflare-containers'").bind(boxId).first()
  if (cloud) await asRpc<CloudBoxRpc>(env.FACTORY_COMPUTE.getByName(cloudBoxName(boxId))).wake(boxId)
}

export type CloudBox = { id: string; nodeId: string; taskId: string; agentId: string; initiatedBy: string; environmentJson: string; status: string; runId: string | null; runStatus: string | null
  checkpointSha: string | null; enabled: number; capabilitiesJson: string }
/** A Cloudflare box as its Durable Object sees it, with its Node. */
export async function cloudBox(env: L4Env, boxId: string) {
  return await env.DB.prepare(`SELECT b.id,b.node_id AS nodeId,b.task_id AS taskId,b.agent_id AS agentId,b.initiated_by AS initiatedBy,b.environment_json AS environmentJson,b.status,b.run_id AS runId,
    (SELECT status FROM agent_runs WHERE id=b.run_id) AS runStatus,b.checkpoint_sha AS checkpointSha,n.enabled,n.capabilities_json AS capabilitiesJson
    FROM factory_boxes b JOIN compute_nodes n ON n.id=b.node_id WHERE b.id=? AND json_extract(n.capabilities_json,'$.provider')='cloudflare-containers'`).bind(boxId).first<CloudBox>()
}

/** What a Cloudflare box's outbound Worker checks on every request: the box still holds this lease on an enabled Node. */
export async function leasedCloudBox(env: L4Env, boxId: string, lease: string) {
  return await env.DB.prepare(`SELECT b.id,b.task_id AS taskId,b.agent_id AS agentId,b.initiated_by AS initiatedBy,b.environment_json AS environmentJson FROM factory_boxes b
    JOIN compute_nodes n ON n.id=b.node_id AND n.enabled=1 AND json_extract(n.capabilities_json,'$.provider')='cloudflare-containers'
    WHERE b.id=? AND b.lease_token=? AND b.lease_until>? AND b.status IN ${ACTIVE}`).bind(boxId, lease, nowIso())
    .first<{ id: string; taskId: string; agentId: string; initiatedBy: string; environmentJson: string }>()
}

/**
 * Gives the Task's box this Run's turn, creating the box on its first turn. The box stays pinned to the
 * repository snapshot, conversation and Node it was made for, and one released with its Task is never reused.
 */
export async function ensureBox(env: L4Env, run: AgentRun, nodeId: string) {
  const environment = JSON.stringify(JSON.parse(run.environmentJson!)), now = nowIso()
  const box = await env.DB.prepare(`INSERT INTO factory_boxes(id,channel_id,task_id,agent_id,initiated_by,node_id,environment_json,origin_run_id,run_id,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(task_id,agent_id,initiated_by) DO UPDATE SET run_id=excluded.run_id,updated_at=excluded.updated_at
    WHERE factory_boxes.status<>'released' AND factory_boxes.channel_id=excluded.channel_id AND factory_boxes.environment_json=excluded.environment_json AND factory_boxes.node_id=excluded.node_id
    RETURNING id,runtime_ms AS runtimeMs`).bind(newId(), run.channelId, run.taskId, run.agentId, run.initiatedBy, nodeId, environment, run.id, run.id, now, now).first<{ id: string; runtimeMs: number }>()
  if (!box) fail(403, 'factory_revoked', 'The Task’s box belongs to a different repository snapshot, conversation or Node, or was released when the Task was done. Start a new Task.')
  if (box.runtimeMs >= ((JSON.parse(run.mandateJson) as RunMandate).execution?.boxRuntimeMs ?? 21600000)) {
    await env.DB.prepare('UPDATE factory_boxes SET run_id=NULL WHERE id=? AND run_id=?').bind(box.id, run.id).run()
    fail(403, 'factory_budget', 'This Task’s box has used its runtime. Raise the box runtime limit in Settings → Agents, or start a new Task.')
  }
  return box.id
}

/** The turn has ended or was cancelled: the next sync tells the Node to stop it, and a Cloudflare box hears it now. */
export async function releaseBoxTurn(env: L4Env, runId: string) {
  const released = await env.DB.prepare('UPDATE factory_boxes SET run_id=NULL,updated_at=? WHERE run_id=? RETURNING id').bind(nowIso(), runId).all<{ id: string }>()
  for (const { id } of released.results) await wakeCloudBox(env, id).catch(() => undefined)
}

/** What still waits before a box's turn may end: a person's decision or a push under way. The commits themselves are in Git. */
export async function boxCompletion(env: L4Env, run: AgentRun) {
  const pending = await env.DB.prepare(`SELECT 1 FROM factory_approvals WHERE run_id=? AND status IN ${OPEN_APPROVALS} AND expires_at>? LIMIT 1`).bind(run.id, nowIso()).first()
  return { pending: Boolean(pending) }
}

type SyncRow = FactoryBox & { runStatus: string | null }
/**
 * One Node's sync: it reports its capacity and the boxes it holds, and gets back what each should do.
 * Every listed box under its current lease is renewed for a minute. A box whose lease has ended, or that
 * the Node holds under an old one, must stop: another start may already hold it. Waiting boxes are admitted
 * in order within the Node's capacity; the rest show the Task as waiting for a free box.
 */
export async function computeSync(env: L4Env, nodeId: string, input: z.infer<typeof boxSyncInput>) {
  const { boxes } = await syncBoxes(env, nodeId, input)
  return { boxes }
}

/**
 * The sync itself. It also says which boxes this sync admitted and released: a Cloudflare box syncs only
 * for itself, so it wakes those others, which have no daemon to hear it.
 */
export async function syncBoxes(env: L4Env, nodeId: string, input: z.infer<typeof boxSyncInput>) {
  const now = nowIso(), renewed = leaseUntil()
  const { diskFree: _diskFree, ...capacity } = input.capacity
  const reported = new Map(input.boxes.map(box => [box.id, box]))
  const [node, , released] = await env.DB.batch([
    // A paired Node reports what its host has now; a Cloudflare Node's capacity is what it was provisioned with.
    env.DB.prepare(`UPDATE compute_nodes SET capabilities_json=CASE WHEN json_extract(capabilities_json,'$.docker')=1 THEN json_set(capabilities_json,'$.capacity',json(?)) ELSE capabilities_json END
      WHERE id=? AND json_extract(capabilities_json,'$.protocol')=2 RETURNING capabilities_json AS capabilitiesJson,enabled`).bind(JSON.stringify(capacity), nodeId),
    env.DB.prepare(`UPDATE factory_boxes SET status='stopped',lease_token=NULL,lease_until=NULL,cpu=NULL,memory_mib=NULL,updated_at=? WHERE node_id=? AND status IN ${ACTIVE} AND lease_until<=?`).bind(now, nodeId, now),
    // A Done or archived Task's work is in its pull request; with no turn running, the Node may drop its disk.
    env.DB.prepare(`UPDATE factory_boxes SET status='released',lease_token=NULL,lease_until=NULL,cpu=NULL,memory_mib=NULL,run_id=NULL,updated_at=? WHERE node_id=? AND status<>'released'
      AND task_id IN (SELECT id FROM tasks WHERE status='done' OR archived_at IS NOT NULL) AND (run_id IS NULL OR run_id NOT IN (SELECT id FROM agent_runs WHERE status='running')) RETURNING id`).bind(now, nodeId),
    env.DB.prepare("UPDATE factory_boxes SET run_id=NULL,updated_at=? WHERE node_id=? AND run_id IS NOT NULL AND run_id NOT IN (SELECT id FROM agent_runs WHERE status='running')").bind(now, nodeId),
    ...input.boxes.map(box => env.DB.prepare(`UPDATE factory_boxes SET status=?,lease_until=CASE WHEN ? IN ('stopped','failed') THEN NULL ELSE ? END,
      lease_token=CASE WHEN ? IN ('stopped','failed') THEN NULL ELSE lease_token END,cpu=CASE WHEN ? IN ('stopped','failed') THEN NULL ELSE cpu END,
      memory_mib=CASE WHEN ? IN ('stopped','failed') THEN NULL ELSE memory_mib END,runtime_ms=MAX(runtime_ms,?),updated_at=?
      WHERE id=? AND node_id=? AND lease_token=? AND status IN ${ACTIVE}`).bind(box.state, box.state, renewed, box.state, box.state, box.state, box.runtimeMs, now, box.id, nodeId, box.lease)),
  ])
  const stored = (node?.results as Array<{ capabilitiesJson: string; enabled: number }> | undefined)?.[0]
  const capabilities = stored ? computeCapabilities.safeParse(JSON.parse(stored.capabilitiesJson)) : null
  if (!capabilities?.success) fail(409, 'compute_protocol', 'This Node was paired with an older protocol. Pair it again from Settings → Compute.')
  const releasedIds = new Set((released?.results as Array<{ id: string }> | undefined ?? []).map(row => row.id))
  const rows = (await env.DB.prepare(`SELECT ${boxColumns},(SELECT status FROM agent_runs WHERE id=factory_boxes.run_id) AS runStatus FROM factory_boxes
    WHERE node_id=? AND (status<>'released' OR id IN (SELECT value FROM json_each(?))) ORDER BY updated_at,id`).bind(nodeId, JSON.stringify([...reported.keys()])).all<SyncRow>()).results

  const active = rows.filter(row => ['starting', 'running', 'idle'].includes(row.status))
  // A paused Node admits nothing; its boxes wait until it is enabled again.
  const waiting = stored!.enabled ? rows.filter(row => ['new', 'queued', 'stopped', 'failed'].includes(row.status) && row.runId && row.runStatus === 'running') : []
  const { admitted, queued, reservation } = admitBoxes(capabilities.data.capacity, active.map(row => ({ cpu: row.cpu ?? 0, memoryMiB: row.memoryMib ?? 0 })), waiting)
  const leases = new Map(admitted.map(row => [row.id, secret()]))
  const nowQueued = queued.filter(row => row.status !== 'queued'), wasQueued = new Set(admitted.filter(row => row.status === 'queued').map(row => row.id))
  if (admitted.length || nowQueued.length) {
    const results = await env.DB.batch([
      // The count guards a sync that overlaps another: together they never exceed the Node's boxes.
      ...admitted.map(row => env.DB.prepare(`UPDATE factory_boxes SET status='starting',lease_token=?,lease_until=?,cpu=?,memory_mib=?,updated_at=? WHERE id=? AND status=?
        AND (SELECT count(*) FROM factory_boxes WHERE node_id=? AND status IN ${ACTIVE})<? RETURNING id`).bind(leases.get(row.id)!, renewed, reservation.cpu, reservation.memoryMiB, now, row.id, row.status, nodeId, capabilities.data.capacity.boxes)),
      ...nowQueued.map(row => env.DB.prepare("UPDATE factory_boxes SET status='queued',updated_at=? WHERE id=? AND status=?").bind(now, row.id, row.status)),
    ])
    admitted.forEach((row, index) => {
      if ((results[index]?.results as unknown[] | undefined)?.length) Object.assign(row, { status: 'starting', leaseToken: leases.get(row.id)!, leaseUntil: renewed, cpu: reservation.cpu, memoryMib: reservation.memoryMiB })
    })
    // The Task shows why nothing happens yet, and that work began once it has a box.
    const turns = [...nowQueued.map(row => ({ row, detail: BOX_WAITING_DETAIL })), ...admitted.filter(row => row.status === 'starting' && wasQueued.has(row.id)).map(row => ({ row, detail: 'Working' }))]
    for (const { row, detail } of turns) await patchAgentTurn(env, row.runId!, { detail })
    for (const key of new Set(turns.map(({ row }) => `${row.channelId}\n${row.agentId}`))) {
      const [channelId, agentId] = key.split('\n') as [string, string]
      await fanoutAgentTurns(env, channelId, agentId)
    }
  }

  const leased = (row: SyncRow) => ['starting', 'running', 'idle'].includes(row.status) && Boolean(row.leaseToken)
  const byId = new Map(rows.map(row => [row.id, row]))
  // A box that holds a lease runs under it: a Node that still has an older one takes the new one over.
  // A box without one must stop, since its share may already be another box's.
  const answer = (row: SyncRow | undefined, report: z.infer<typeof boxSyncInput>['boxes'][number] | undefined) => {
    const id = row?.id ?? report!.id
    const holds = row && leased(row)
    const want = !row || row.status === 'released' || releasedIds.has(id) ? 'released' : holds ? 'running' : 'stopped'
    const turnRunId = holds && row.runId && row.runStatus === 'running' ? row.runId : null
    return { id, lease: holds ? row.leaseToken! : report!.lease, want, taskId: row?.taskId ?? null, image: capabilities.data.image, diskBytes: capabilities.data.diskBytes,
      cpu: row?.cpu ?? reservation.cpu, memoryMiB: row?.memoryMib ?? reservation.memoryMiB,
      ...(turnRunId ? { turn: { runId: turnRunId } } : {}),
      // The Node is running a turn that is no longer the box's: cancelled, failed or replaced.
      ...(report?.runId && report.runId !== turnRunId ? { cancelRunId: report.runId } : {}),
      // Network windows and Project secrets fill these; until then a box reaches only this Server.
      egress: { revision: 0, hosts: [] as string[], secretHosts: [] as string[] } }
  }
  const listed = [
    ...rows.filter(row => leased(row) || reported.has(row.id)).map(row => answer(row, reported.get(row.id))),
    ...[...reported.values()].filter(report => !byId.has(report.id)).map(report => answer(undefined, report)),
  ]
  // A running box's pushes: the review to make of one, or the approved one to push.
  const outward = await boxOutwardWork(env, listed.filter(box => box.want === 'running').map(box => box.id))
  const boxes = listed.map(box => ({ ...box, ...outward.get(box.id) }))
  const started = admitted.filter(row => row.status === 'starting' && leases.get(row.id) === row.leaseToken).map(row => row.id)
  return { boxes, admitted: started, released: [...releasedIds] }
}

/**
 * The Node asks for the turn it was told to run. The submission, which holds the Run's gateway
 * capability, stays in the Run's Durable Object and goes only to the Node holding the box's lease.
 */
export async function computeTurn(env: L4Env, nodeId: string, input: z.infer<typeof boxTurnInput>) {
  const box = await env.DB.prepare(`SELECT b.id FROM factory_boxes b JOIN agent_runs r ON r.id=b.run_id WHERE b.id=? AND b.node_id=? AND b.lease_token=? AND b.lease_until>? AND b.run_id=?
    AND b.status IN ${ACTIVE} AND r.status='running'`).bind(input.boxId, nodeId, input.lease, nowIso(), input.runId).first()
  if (!box) fail(403, 'box_turn_denied', 'This turn is not the box’s under its current lease')
  const submission = await boxRun(env, input.runId).boxSubmission(input.runId)
  if (!submission) fail(409, 'box_turn_unavailable', 'The Run has not handed over its turn yet')
  return { submission }
}
