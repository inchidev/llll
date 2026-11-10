import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createHmac } from 'node:crypto'
import { mcpFixture, ids } from '../helpers/outbound-mcp'
import { computePoll, pairComputeNode } from '../../server/utils/compute-nodes'
import { ensureBox } from '../../server/utils/factory-boxes'
import { beginL4ComputeLink, completeL4ComputeLink } from '../../server/utils/l4-compute'
import { boxPreviewKey, PREVIEW_TICKET_MS, previewTicket, taskPreview } from '../../server/utils/box-preview'
import { BOX_SCREEN_BRIEF, BOX_WATCHED_BRIEF, boxRunBrief } from '../../server/utils/box-egress'
import { findAgentRun } from '../../server/utils/agent-run-service'
import { L4_COMPUTE_CAPABILITIES } from '../../shared/software-factory'

/**
 * Watching a Task's box: the Server gives an L4 Compute box's Node a preview key derived from the box's lease, the
 * Node reports whether its viewer runs, and a person who may read the Task gets a short-lived link: llll.gg's HTTPS
 * address of the box's preview port with a ticket the Node's gate checks. llll.gg is a mock here.
 */
const origin = 'https://server.example', serverToken = 'srv_' + 'c'.repeat(40)
const image = 'registry.example/l4@sha256:' + 'b'.repeat(64)
const dockerCapabilities = { diskBytes: 10737418240, docker: true, durableDisk: true, isolation: 'shared-kernel', image, capacity: { cpu: 2, memoryMiB: 4096, boxes: 1 }, protocol: 2 } as const
const capacity = { cpu: 2, memoryMiB: 4096, boxes: 1, diskFree: 50000000000 }
const exposed = 'https://sbx-6901.sandbox.us-east-1.onlizard.com/?lizard_token=provider-token'
type Call = { url: string; method: string }
type Synced = { boxes: Array<{ id: string; lease: string; want: string; preview?: { key: string } }> }
let f: ReturnType<typeof mcpFixture>, calls: Call[], preview: () => Response

beforeEach(() => {
  f = mcpFixture()
  Object.assign(f.env, { PUBLIC_ORIGIN: origin })
  calls = []
  preview = () => Response.json({ url: exposed })
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input), method = init?.method ?? 'GET'
    calls.push({ url, method })
    if (url.endsWith('/api/compute/link')) return Response.json({ token: serverToken, serverId: ids.server, origin, account: 'owner@example.com' })
    if (url.endsWith('/api/compute/boxes') && method === 'POST') return Response.json({ boxId: 'bx_1', state: 'starting' }, { status: 201 })
    if (url.endsWith('/confirm')) return Response.json({ boxId: 'bx_1', state: 'running' })
    if (url.endsWith('/api/compute/boxes/bx_1/preview') && method === 'POST') return preview()
    return new Response('not found', { status: 404 })
  }))
})
afterEach(() => { f.db.close(); vi.unstubAllGlobals() })

async function runningBox() {
  const { url } = await beginL4ComputeLink(f.env, await f.actor())
  await completeL4ComputeLink(f.env, await f.actor(), 'code-1', new URL(url).searchParams.get('state')!)
  const placement = (f.db.prepare("SELECT id FROM compute_nodes WHERE placement_id IS NULL AND json_extract(capabilities_json,'$.provider')='l4-compute'").get() as { id: string }).id
  f.db.prepare("INSERT OR IGNORE INTO task_boards(id,name,created_by) VALUES('l4-board','Factory',?)").run(ids.owner)
  f.db.prepare("INSERT INTO tasks(id,board_id,title,assignee_id,created_by,status) VALUES('task-view','l4-board','A game',?,?,'ready')").run(ids.agent, ids.owner)
  const created = await f.run(ids.owner, undefined, 'task-view')
  const environment = { id: 'l4-env', enabled: true, version: 1, name: 'Game', computeNodeId: placement, sourceRepo: 'game', baseBranch: 'main', requiredChecks: [], previewHosts: [], baseSha: 'a'.repeat(40), baseTreeSha: 'b'.repeat(40) }
  f.db.prepare('UPDATE agent_runs SET environment_json=? WHERE id=?').run(JSON.stringify(environment), created.run.id)
  const run = (await findAgentRun(f.env, created.run.id))!
  calls.length = 0
  const boxId = await ensureBox(f.env, run, placement, L4_COMPUTE_CAPABILITIES)
  const pairingToken = (JSON.parse(String((vi.mocked(fetch).mock.calls.find(([input]) => String(input).endsWith('/api/compute/boxes'))![1] as RequestInit).body)) as { pairingToken: string }).pairingToken
  const paired = await pairComputeNode(f.env, pairingToken, { ...dockerCapabilities })
  const first = await computePoll(f.env, paired.nodeId, { operation: 'sync', capacity, boxes: [] }) as Synced
  return { boxId, nodeId: paired.nodeId, placement, run, lease: first.boxes[0]!.lease, first }
}
const sync = (nodeId: string, box: Record<string, unknown>) => computePoll(f.env, nodeId, { operation: 'sync', capacity, boxes: [box] } as never) as Promise<Synced>
const previewColumn = (boxId: string) => (f.db.prepare('SELECT preview FROM factory_boxes WHERE id=?').get(boxId) as { preview: number }).preview

it('gives an L4 Compute box’s Node a preview key from the lease, and stores only whether the viewer runs', async () => {
  const { boxId, nodeId, lease, first } = await runningBox()
  const key = await boxPreviewKey(f.env, boxId, lease)
  expect(key).toMatch(/^[a-f0-9]{64}$/u)
  expect(first.boxes[0]).toMatchObject({ id: boxId, want: 'running', preview: { key } })
  // A Node of an earlier release reports no viewer: nothing changes and nothing is refused.
  await sync(nodeId, { id: boxId, lease, state: 'idle', runtimeMs: 10 })
  expect(previewColumn(boxId)).toBe(0)
  const answer = await sync(nodeId, { id: boxId, lease, state: 'idle', runtimeMs: 20, preview: true })
  expect(answer.boxes[0]!.preview).toEqual({ key })
  expect(previewColumn(boxId)).toBe(1)
  // The key itself is never stored.
  expect(JSON.stringify(f.db.prepare('SELECT * FROM factory_boxes').all())).not.toContain(key)
  // A stopped box has no viewer.
  await sync(nodeId, { id: boxId, lease, state: 'stopped', runtimeMs: 30, preview: true })
  expect(previewColumn(boxId)).toBe(0)
})

it('hands a person who may read the Task a short-lived link with a ticket the gate can check, and takes no turn', async () => {
  const { boxId, nodeId, lease, run } = await runningBox()
  await sync(nodeId, { id: boxId, lease, state: 'running', runId: run.id, runtimeMs: 20, preview: true })
  const turnBefore = f.db.prepare('SELECT run_id AS runId,status,updated_at AS updatedAt FROM factory_boxes WHERE id=?').get(boxId)
  calls.length = 0
  const now = Date.now()
  const answer = (await taskPreview(f.env, await f.actor(), 'task-view', now))!
  expect(calls).toEqual([{ url: 'https://llll.gg/api/compute/boxes/bx_1/preview', method: 'POST' }])
  expect(answer.expiresAt).toBe(new Date(now + PREVIEW_TICKET_MS).toISOString())
  const url = new URL(answer.url)
  expect(url.origin).toBe('https://sbx-6901.sandbox.us-east-1.onlizard.com')
  expect(url.searchParams.get('lizard_token')).toBe('provider-token')
  const ticket = url.searchParams.get('token')!
  const [ticketBox, expires, signature] = ticket.split('.')
  expect([ticketBox, Number(expires)]).toEqual([boxId, now + PREVIEW_TICKET_MS])
  // The gate checks it with the key its Node was given, as preview-gate.mjs does.
  const key = await boxPreviewKey(f.env, boxId, lease)
  expect(signature).toBe(createHmac('sha256', key).update(`${boxId}.${now + PREVIEW_TICKET_MS}`).digest('hex'))
  expect(ticket).toBe(await previewTicket(key, boxId, now + PREVIEW_TICKET_MS))
  // Watching changes nothing about the box or its turn.
  expect(f.db.prepare('SELECT run_id AS runId,status,updated_at AS updatedAt FROM factory_boxes WHERE id=?').get(boxId)).toEqual(turnBefore)
})

it('answers nothing to watch while no box runs with a viewer, or when llll.gg has none', async () => {
  const { boxId, nodeId, lease } = await runningBox()
  calls.length = 0
  expect(await taskPreview(f.env, await f.actor(), 'task-view')).toBeNull()
  expect(calls).toEqual([])
  await sync(nodeId, { id: boxId, lease, state: 'idle', runtimeMs: 20, preview: true })
  preview = () => new Response('gone', { status: 404 })
  expect(await taskPreview(f.env, await f.actor(), 'task-view')).toBeNull()
  preview = () => new Response('down', { status: 503 })
  await expect(taskPreview(f.env, await f.actor(), 'task-view')).rejects.toMatchObject({ statusCode: 502 })
  preview = () => Response.json({ url: 'http://plain.example/' })
  await expect(taskPreview(f.env, await f.actor(), 'task-view')).rejects.toMatchObject({ statusCode: 502 })
  // A lease that ended: the box is not running whatever was last reported.
  f.db.prepare('UPDATE factory_boxes SET lease_until=? WHERE id=?').run(new Date(Date.now() - 1000).toISOString(), boxId)
  preview = () => Response.json({ url: exposed })
  expect(await taskPreview(f.env, await f.actor(), 'task-view')).toBeNull()
  await expect(taskPreview(f.env, await f.actor(), 'missing-task')).rejects.toMatchObject({ statusCode: 404 })
})

it('refuses a person who may not read the Task', async () => {
  const { boxId, nodeId, lease } = await runningBox()
  await sync(nodeId, { id: boxId, lease, state: 'idle', runtimeMs: 20, preview: true })
  // A Member who reads the Task may watch; once its board is in a Space they are not in, they may not.
  expect(await taskPreview(f.env, await f.actor(ids.member), 'task-view')).toMatchObject({ url: expect.stringContaining('token=') })
  f.db.prepare("UPDATE task_boards SET space_id='space-other' WHERE id='l4-board'").run()
  const space = f.db.prepare("SELECT 1 FROM spaces WHERE id='space-other'").get()
  if (!space) f.db.prepare("INSERT INTO spaces(id,name,created_by,created_at) VALUES('space-other','Other',?,?)").run(ids.owner, new Date().toISOString())
  calls.length = 0
  await expect(taskPreview(f.env, await f.actor(ids.member), 'task-view')).rejects.toMatchObject({ statusCode: 404 })
  expect(calls).toEqual([])
})

it('gives a VPS Node no preview key: only L4 Compute exposes a box’s screen', async () => {
  const { pairComputeNode: pair } = await import('../../server/utils/compute-nodes')
  const { prepareComputePairing } = await import('../../server/utils/compute-nodes')
  const pairing = await prepareComputePairing(f.env, await f.actor(), 'VPS')
  const node = await pair(f.env, pairing.token, { ...dockerCapabilities })
  const answer = await computePoll(f.env, node.nodeId, { operation: 'sync', capacity, boxes: [] }) as Synced
  expect(answer.boxes.every(box => !box.preview)).toBe(true)
})

it('tells the box’s Agent about its screen and browser, and that the person may watch on L4 Compute', async () => {
  const { placement } = await runningBox()
  const mandateJson = JSON.stringify({})
  expect(await boxRunBrief(f.env, { mandateJson, environmentJson: JSON.stringify({ computeNodeId: placement }) })).toContain(`${BOX_SCREEN_BRIEF}\n${BOX_WATCHED_BRIEF}`)
  const cloudflare = 'node-cloudflare'
  f.db.prepare('INSERT INTO compute_nodes(id,name,token_hash,capabilities_json,created_by,created_at) VALUES(?,?,?,?,?,?)')
    .run(cloudflare, 'Cloudflare', 'x', JSON.stringify({ provider: 'cloudflare-containers' }), ids.owner, new Date().toISOString())
  const onCloudflare = await boxRunBrief(f.env, { mandateJson, environmentJson: JSON.stringify({ computeNodeId: cloudflare }) })
  expect(onCloudflare).not.toContain('DISPLAY')
  const vps = 'node-vps'
  f.db.prepare('INSERT INTO compute_nodes(id,name,token_hash,capabilities_json,created_by,created_at) VALUES(?,?,?,?,?,?)')
    .run(vps, 'VPS', 'y', JSON.stringify(dockerCapabilities), ids.owner, new Date().toISOString())
  const onVps = await boxRunBrief(f.env, { mandateJson, environmentJson: JSON.stringify({ computeNodeId: vps }) })
  expect(onVps).toContain(BOX_SCREEN_BRIEF)
  expect(onVps).not.toContain(BOX_WATCHED_BRIEF)
})
