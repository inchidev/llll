import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mcpFixture, ids } from '../helpers/outbound-mcp'
import { fakeArtifacts, type FakeArtifacts } from '../helpers/artifacts'
import { computePoll, pairComputeNode, requireComputeNode } from '../../server/utils/compute-nodes'
import { ensureBox } from '../../server/utils/factory-boxes'
import { beginL4ComputeLink, completeL4ComputeLink, releaseL4BoxesForTasks } from '../../server/utils/l4-compute'
import { checkpointTransport } from '../../server/utils/box-checkpoints'
import { findAgentRun } from '../../server/utils/agent-run-service'
import { pack, pktLine } from '../../server/utils/git-pack'
import { factoryRepositoryName, L4_COMPUTE_CAPABILITIES } from '../../shared/software-factory'

/**
 * An idle L4 Compute box gives its machine back (ADR 0011, 0013): its daemon saves the Task disk to the box's private
 * Artifacts checkpoint through the Server, the Server acknowledges it once Artifacts holds it, and only a box reported
 * stopped at that checkpoint with no turn waiting is let go at llll.gg. The next turn's new machine restores the
 * checkpoint instead of the pinned source, and a Done Task takes the checkpoint with it. llll.gg and Artifacts are fakes.
 */
const origin = 'https://server.example', serverToken = 'srv_' + 'a'.repeat(40)
const image = 'registry.example/l4@sha256:' + 'b'.repeat(64)
const dockerCapabilities = { diskBytes: 10737418240, docker: true, durableDisk: true, isolation: 'shared-kernel', image, capacity: { cpu: 2, memoryMiB: 4096, boxes: 1 }, protocol: 2 } as const
const capacity = { cpu: 2, memoryMiB: 4096, boxes: 1, diskFree: 50000000000 }
const baseSha = 'a'.repeat(40), head = 'c'.repeat(40), staged = 'd'.repeat(40), saved = 'e'.repeat(40), zero = '0'.repeat(40)
const environment = { id: 'l4-env', enabled: true, version: 1, name: 'Afterprompt', sourceRepo: 'inchidev/afterprompt', sourceRepoId: 11, sourceInstallationId: 101,
  workRepo: 'inchidev/afterprompt', workRepoId: 11, workInstallationId: 101, baseBranch: 'main', requiredChecks: [], previewHosts: [], baseSha, baseTreeSha: 'b'.repeat(40) }
type Call = { url: string; method: string }
type SyncAnswer = { boxes: Array<{ id: string; lease: string; want: string; checkpoint?: true; turn?: { runId: string } }> }
let f: ReturnType<typeof mcpFixture>, fake: FakeArtifacts, calls: Call[], nextBox: string

beforeEach(() => {
  f = mcpFixture()
  fake = fakeArtifacts()
  Object.assign(f.env, { PUBLIC_ORIGIN: origin, FACTORY_CODE: fake.binding })
  calls = []
  nextBox = 'bx_1'
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input), method = init?.method ?? (input instanceof Request ? input.method : 'GET')
    if (new URL(url).hostname.endsWith('.artifacts.cloudflare.net')) return fake.network(input, init)
    calls.push({ url, method })
    if (url.endsWith('/api/compute/link')) return Response.json({ token: serverToken, serverId: ids.server, origin, account: 'owner@example.com' })
    if (url.endsWith('/api/compute/boxes') && method === 'POST') return Response.json({ boxId: nextBox, taskId: 'task', size: 'small', state: 'starting' }, { status: 201 })
    if (url.endsWith('/confirm')) return Response.json({ boxId: nextBox, state: 'running' })
    if (url.includes('/api/compute/boxes/') && method === 'DELETE') return new Response(null, { status: 204 })
    return new Response('not found', { status: 404 })
  }))
})
afterEach(() => { f.db.close(); vi.unstubAllGlobals() })

const row = (id: string) => f.db.prepare('SELECT status,node_id AS nodeId,run_id AS runId,cloud_box_id AS cloudBoxId,checkpoint_sha AS checkpointSha,head_sha AS headSha FROM factory_boxes WHERE id=?').get(id) as
  { status: string; nodeId: string; runId: string | null; cloudBoxId: string | null; checkpointSha: string | null; headSha: string | null }
const deletes = () => calls.filter(call => call.method === 'DELETE').map(call => call.url)

async function link() {
  const { url } = await beginL4ComputeLink(f.env, await f.actor())
  await completeL4ComputeLink(f.env, await f.actor(), 'code-1', new URL(url).searchParams.get('state')!)
  return (f.db.prepare("SELECT id FROM compute_nodes WHERE placement_id IS NULL AND json_extract(capabilities_json,'$.provider')='l4-compute'").get() as { id: string }).id
}
/** One turn of the Task, on the repository whose Compute Node is the L4 Compute placement. */
async function turn(taskId: string, placement: string) {
  f.db.prepare("INSERT OR IGNORE INTO task_boards(id,name,created_by) VALUES('l4-board','Factory',?)").run(ids.owner)
  f.db.prepare("INSERT OR IGNORE INTO tasks(id,board_id,title,assignee_id,created_by,status) VALUES(?,?,?,?,?,'ready')").run(taskId, 'l4-board', 'Ship ' + taskId, ids.agent, ids.owner)
  const created = await f.run(ids.owner, undefined, taskId)
  f.db.prepare('UPDATE agent_runs SET environment_json=? WHERE id=?').run(JSON.stringify({ ...environment, computeNodeId: placement }), created.run.id)
  return (await findAgentRun(f.env, created.run.id))!
}
/** The turn's machine pairs and its box is admitted; returns its Node and lease. */
async function started(placement: string, run: Awaited<ReturnType<typeof turn>>) {
  const boxId = await ensureBox(f.env, run, placement, L4_COMPUTE_CAPABILITIES)
  const pairing = f.db.prepare('SELECT 1 FROM compute_pairings WHERE box_id=?').get(boxId)
  expect(pairing).toBeTruthy()
  const pairingToken = (vi.mocked(fetch).mock.calls.filter(([url, init]) => String(url).endsWith('/api/compute/boxes') && init?.method === 'POST').at(-1)![1]!.body as string)
  const paired = await pairComputeNode(f.env, JSON.parse(pairingToken).pairingToken, { ...dockerCapabilities })
  const answer = await computePoll(f.env, paired.nodeId, { operation: 'sync', capacity, boxes: [] }) as SyncAnswer
  return { boxId, node: paired, lease: answer.boxes[0]!.lease, answer }
}
const finish = (runId: string) => f.db.prepare("UPDATE agent_runs SET status='completed' WHERE id=?").run(runId)
/** What the daemon's push leaves in the box's repository: the checkpoint commit, then `l4-state` at it through the Server. */
async function pushed(boxId: string, authorization: string, sha = saved, parents = [head, staged]) {
  fake.seed(factoryRepositoryName(ids.server, boxId), { hash: sha, treeHash: 'f'.repeat(40), parents, message: 'Private working files checkpoint' })
  const body = Buffer.concat([Buffer.from(pktLine(`${zero} ${sha} refs/heads/l4-state\0report-status\n`) + '0000'), Buffer.from(await pack([]))])
  return checkpointTransport(f.env, boxId, authorization.replace(/^Bearer /u, ''), '/git-receive-pack',
    new Request(`${origin}/api/compute-agent/checkpoint/${boxId}.git/git-receive-pack`, { method: 'POST', headers: { 'Content-Type': 'application/x-git-receive-pack-request' }, body: body.toString('latin1') }))
}
/** A box that worked one turn and went idle, with its checkpoint acknowledged. */
async function savedIdleBox(taskId = 'task-park') {
  const placement = await link()
  const run = await turn(taskId, placement)
  const box = await started(placement, run)
  finish(run.id)
  await computePoll(f.env, box.node.nodeId, { operation: 'sync', capacity, boxes: [{ id: box.boxId, lease: box.lease, state: 'idle', runtimeMs: 60000 }] })
  const grant = await computePoll(f.env, box.node.nodeId, { operation: 'checkpoint', boxId: box.boxId, lease: box.lease }) as { remote: string; authorization: string; previous: string | null; baseSha: string }
  expect((await pushed(box.boxId, grant.authorization)).status).toBe(200)
  await computePoll(f.env, box.node.nodeId, { operation: 'checkpointed', boxId: box.boxId, lease: box.lease, checkpoint: saved, head })
  return { placement, run, ...box, grant }
}

it('saves an idle box through the Server, acknowledges it only as Artifacts holds it, then lets the machine go and keeps the checkpoint', async () => {
  const placement = await link()
  const run = await turn('task-park', placement)
  const box = await started(placement, run)
  // A box's own L4 Compute Node is told to save its boxes when idle; Artifacts is bound here.
  expect(box.answer.boxes[0]).toMatchObject({ id: box.boxId, want: 'running', checkpoint: true, turn: { runId: run.id } })
  finish(run.id)
  await computePoll(f.env, box.node.nodeId, { operation: 'sync', capacity, boxes: [{ id: box.boxId, lease: box.lease, state: 'idle', runtimeMs: 60000 }] })

  // The grant: where to push through this Server, with a capability for this box and lease; no Artifacts token.
  const grant = await computePoll(f.env, box.node.nodeId, { operation: 'checkpoint', boxId: box.boxId, lease: box.lease }) as { remote: string; authorization: string; previous: string | null; baseSha: string }
  expect(grant).toEqual({ remote: `${origin}/api/compute-agent/checkpoint/${box.boxId}.git`, authorization: expect.stringMatching(/^Bearer [a-f0-9]{64}$/u), baseSha, previous: null })
  const name = factoryRepositoryName(ids.server, box.boxId)
  expect(fake.repos.get(name)).toMatchObject({ defaultBranch: 'l4-state', deleted: false })
  expect(fake.liveTokens(fake.repos.get(name)!)).toEqual([])
  await expect(computePoll(f.env, box.node.nodeId, { operation: 'checkpoint', boxId: box.boxId, lease: 'f'.repeat(64) })).rejects.toMatchObject({ statusCode: 403 })

  // The transport lets only l4-state move, and only with this box's capability.
  const refused = await checkpointTransport(f.env, box.boxId, grant.authorization.slice(7), '/git-receive-pack', new Request(`${grant.remote}/git-receive-pack`, { method: 'POST',
    body: pktLine(`${zero} ${saved} refs/heads/main\0report-status\n`) + '0000PACK' }))
  expect(refused.status).toBe(403)
  expect((await checkpointTransport(f.env, box.boxId, 'f'.repeat(64), '/info/refs', new Request(`${grant.remote}/info/refs?service=git-upload-pack`))).status).toBe(403)
  // Nothing counts before it is in Artifacts.
  await expect(computePoll(f.env, box.node.nodeId, { operation: 'checkpointed', boxId: box.boxId, lease: box.lease, checkpoint: saved, head })).rejects.toMatchObject({ statusCode: 409 })
  expect((await pushed(box.boxId, grant.authorization)).status).toBe(200)
  expect(fake.repos.get(name)!.refs.get('refs/heads/l4-state')).toBe(saved)
  expect(fake.liveTokens(fake.repos.get(name)!)).toEqual([])
  // A checkpoint whose first parent is not the head the daemon names is not this box's.
  await expect(computePoll(f.env, box.node.nodeId, { operation: 'checkpointed', boxId: box.boxId, lease: box.lease, checkpoint: saved, head: staged })).rejects.toMatchObject({ statusCode: 409 })
  expect(row(box.boxId)).toMatchObject({ checkpointSha: null, headSha: null })
  expect(await computePoll(f.env, box.node.nodeId, { operation: 'checkpointed', boxId: box.boxId, lease: box.lease, checkpoint: saved, head })).toEqual({ ok: true })
  expect(row(box.boxId)).toMatchObject({ checkpointSha: saved, headSha: head })

  // The daemon stops the box and says its disk is that checkpoint: llll.gg lets the machine go, the box waits on the placement.
  calls.length = 0
  const answer = await computePoll(f.env, box.node.nodeId, { operation: 'sync', capacity, boxes: [{ id: box.boxId, lease: box.lease, state: 'stopped', runtimeMs: 61000, saved }] }) as SyncAnswer
  expect(answer.boxes).toEqual([expect.objectContaining({ id: box.boxId, want: 'released' })])
  expect(deletes()).toEqual(['https://llll.gg/api/compute/boxes/bx_1'])
  expect(row(box.boxId)).toEqual({ status: 'new', nodeId: placement, runId: null, cloudBoxId: null, checkpointSha: saved, headSha: head })
  expect(fake.repos.get(name)!.deleted).toBe(false)
  await expect(requireComputeNode(f.env, box.node.token)).rejects.toMatchObject({ statusCode: 403 })
})

it('never lets a machine go with unsaved work or a turn waiting', async () => {
  const box = await savedIdleBox()
  calls.length = 0
  // Stopped without saying it was saved (its save failed), or saved at another commit: the machine stays.
  await computePoll(f.env, box.node.nodeId, { operation: 'sync', capacity, boxes: [{ id: box.boxId, lease: box.lease, state: 'stopped', runtimeMs: 61000 }] })
  await computePoll(f.env, box.node.nodeId, { operation: 'sync', capacity, boxes: [{ id: box.boxId, lease: box.lease, state: 'stopped', runtimeMs: 61000, saved: staged }] })
  expect(deletes()).toEqual([])
  expect(row(box.boxId)).toMatchObject({ status: 'stopped', nodeId: box.node.nodeId, cloudBoxId: 'bx_1' })
  // A new turn came for the box while it stopped: it starts again on this machine instead.
  const next = await turn('task-park', box.placement)
  expect(await ensureBox(f.env, next, box.placement, L4_COMPUTE_CAPABILITIES)).toBe(box.boxId)
  const answer = await computePoll(f.env, box.node.nodeId, { operation: 'sync', capacity, boxes: [{ id: box.boxId, lease: box.lease, state: 'stopped', runtimeMs: 61000, saved }] }) as SyncAnswer
  expect(deletes()).toEqual([])
  expect(answer.boxes).toEqual([expect.objectContaining({ id: box.boxId, want: 'running', turn: { runId: next.id } })])
  expect(row(box.boxId)).toMatchObject({ nodeId: box.node.nodeId, cloudBoxId: 'bx_1', checkpointSha: saved })
})

it('starts the next turn on a new machine that restores the checkpoint, not the pinned source', async () => {
  const box = await savedIdleBox()
  await computePoll(f.env, box.node.nodeId, { operation: 'sync', capacity, boxes: [{ id: box.boxId, lease: box.lease, state: 'stopped', runtimeMs: 61000, saved }] })
  nextBox = 'bx_2'
  calls.length = 0
  const next = await turn('task-park', box.placement)
  const again = await started(box.placement, next)
  expect(again.boxId).toBe(box.boxId)
  expect(calls.map(call => `${call.method} ${call.url}`)).toEqual(['POST https://llll.gg/api/compute/boxes', 'POST https://llll.gg/api/compute/boxes/bx_2/confirm'])
  expect(row(box.boxId)).toMatchObject({ nodeId: again.node.nodeId, cloudBoxId: 'bx_2', checkpointSha: saved })
  const grant = await computePoll(f.env, again.node.nodeId, { operation: 'source', boxId: box.boxId, lease: again.lease })
  expect(grant).toEqual({ id: box.boxId, repository: 'inchidev/afterprompt', baseSha, checkpoint: saved,
    source: { remote: `${origin}/api/compute-agent/checkpoint/${box.boxId}.git`, authorization: expect.stringMatching(/^Bearer [a-f0-9]{64}$/u) } })
  // No GitHub grant was asked for the pinned source.
  expect(calls.filter(call => new URL(call.url).hostname.endsWith('github.com'))).toEqual([])
  // The restore reads the checkpoint through the Server with a read token minted for the request.
  const read = await checkpointTransport(f.env, box.boxId, (grant as { source: { authorization: string } }).source.authorization.slice(7), '/info/refs',
    new Request(`${origin}/api/compute-agent/checkpoint/${box.boxId}.git/info/refs?service=git-upload-pack`))
  expect(read.status).toBe(200)
  expect(await read.text()).toContain(`${saved} refs/heads/l4-state`)
  // Its next save names the acknowledged checkpoint as the one before.
  expect(await computePoll(f.env, again.node.nodeId, { operation: 'checkpoint', boxId: box.boxId, lease: again.lease })).toMatchObject({ previous: saved })
})

it('restores a lost box from its last checkpoint instead of losing its work', async () => {
  const box = await savedIdleBox()
  // Its sandbox went before it was let go: the Node is silent past the limit.
  f.db.prepare('UPDATE compute_nodes SET last_seen=? WHERE id=?').run(new Date(Date.now() - 10 * 60_000).toISOString(), box.node.nodeId)
  nextBox = 'bx_2'
  calls.length = 0
  const next = await turn('task-park', box.placement)
  await ensureBox(f.env, next, box.placement, L4_COMPUTE_CAPABILITIES)
  expect(calls.map(call => `${call.method} ${call.url}`)).toEqual(['DELETE https://llll.gg/api/compute/boxes/bx_1', 'POST https://llll.gg/api/compute/boxes'])
  expect(row(box.boxId)).toMatchObject({ status: 'new', nodeId: box.placement, cloudBoxId: 'bx_2', checkpointSha: saved, headSha: head })
})

it('deletes the checkpoint repository with the box when the Task is Done', async () => {
  const box = await savedIdleBox()
  await computePoll(f.env, box.node.nodeId, { operation: 'sync', capacity, boxes: [{ id: box.boxId, lease: box.lease, state: 'stopped', runtimeMs: 61000, saved }] })
  calls.length = 0
  f.db.prepare("UPDATE tasks SET status='done' WHERE id='task-park'").run()
  expect(await releaseL4BoxesForTasks(f.env, ['task-park'])).toEqual([box.boxId])
  expect(row(box.boxId).status).toBe('released')
  expect(fake.repos.get(factoryRepositoryName(ids.server, box.boxId))!.deleted).toBe(true)
  // The machine was let go already; llll.gg hears nothing more.
  expect(deletes()).toEqual([])
})

it('tells no box to save itself where the Server has no Artifacts', async () => {
  Object.assign(f.env, { FACTORY_CODE: undefined })
  const placement = await link()
  const box = await started(placement, await turn('task-plain', placement))
  expect(box.answer.boxes[0]).not.toHaveProperty('checkpoint')
})
