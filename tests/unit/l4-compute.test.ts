import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mcpFixture, ids } from '../helpers/outbound-mcp'
import { factoryHash } from '../../server/utils/factory-authority'
import { computePoll, pairComputeNode, requireComputeNode } from '../../server/utils/compute-nodes'
import { ensureBox } from '../../server/utils/factory-boxes'
import { factorySetup } from '../../server/utils/factory-setup'
import { beginL4ComputeLink, completeL4ComputeLink, disconnectL4Compute, l4ComputeCredential, l4ComputeOverview, L4_COMPUTE_UNREACHABLE, L4_CREDIT_MESSAGE, releaseL4BoxesForTasks } from '../../server/utils/l4-compute'
import { findAgentRun } from '../../server/utils/agent-run-service'
import { L4_COMPUTE_CAPABILITIES } from '../../shared/software-factory'
import { readServerSetting } from '../../shared/server-settings'

/**
 * The Server side of L4 Compute (ADR 0009): the Owner links the Server to llll.gg once, a Task's first turn on the
 * placement asks llll.gg for a box with a one-use pairing code, the box pairs as a Node of its own, and the box
 * goes when the Task is Done. llll.gg itself is a mock here: these tests pin what the Server sends it and how it
 * reads each answer, including a 402 and a silence.
 */
const origin = 'https://server.example', serverToken = 'srv_' + 'a'.repeat(40)
const image = 'registry.example/l4@sha256:' + 'b'.repeat(64)
const dockerCapabilities = { diskBytes: 10737418240, docker: true, durableDisk: true, isolation: 'shared-kernel', image, capacity: { cpu: 2, memoryMiB: 4096, boxes: 1 }, protocol: 2 } as const
type Call = { url: string; method: string; authorization: string | null; body: Record<string, unknown> | null }
let f: ReturnType<typeof mcpFixture>, calls: Call[]
const status = { serverId: ids.server, creditMicrocents: 12050000000, spentThisMonthMicrocents: 1999000000, spendLimitMicrocents: 5000000000, mayStartBox: true, boxes: [] }
const started = (boxId: string) => Response.json({ boxId, taskId: 'task', size: 'small', state: 'starting', reason: null, createdAt: '2026-11-08T12:00:00Z', confirmedAt: null, destroyedAt: null, seconds: 0 }, { status: 201 })
const answers = { status: () => Response.json(status), box: () => started('bx_1'),
  link: () => Response.json({ token: serverToken, serverId: ids.server, origin, account: 'owner@example.com' }), remove: () => new Response(null, { status: 204 }), confirm: () => Response.json({ boxId: 'bx_1', state: 'running' }), down: false }

beforeEach(() => {
  f = mcpFixture()
  Object.assign(f.env, { PUBLIC_ORIGIN: origin })
  calls = []
  answers.status = () => Response.json(status)
  answers.box = () => started('bx_1')
  answers.confirm = () => Response.json({ boxId: 'bx_1', state: 'running' })
  answers.down = false
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input), method = init?.method ?? 'GET'
    calls.push({ url, method, authorization: new Headers(init?.headers).get('Authorization'), body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null })
    if (answers.down) throw new TypeError('fetch failed')
    if (url.endsWith('/api/compute/link')) return answers.link()
    if (url.endsWith('/api/compute/status')) return answers.status()
    if (url.endsWith('/api/compute/boxes') && method === 'POST') return answers.box()
    if (url.endsWith('/confirm') && method === 'POST') return answers.confirm()
    if (url.includes('/api/compute/boxes/') && method === 'DELETE') return answers.remove()
    return new Response('not found', { status: 404 })
  }))
})
afterEach(() => { f.db.close(); vi.unstubAllGlobals() })

const linkRow = () => f.db.prepare('SELECT account,token_ciphertext AS ciphertext,linked_by AS linkedBy FROM l4_compute_link WHERE singleton=1').get() as { account: string; ciphertext: string; linkedBy: string } | undefined
const placement = () => f.db.prepare("SELECT id,name,enabled FROM compute_nodes WHERE placement_id IS NULL AND json_extract(capabilities_json,'$.provider')='l4-compute'").get() as { id: string; name: string; enabled: number } | undefined
const boxRow = (id: string) => f.db.prepare('SELECT status,node_id AS nodeId,run_id AS runId,cloud_box_id AS cloudBoxId,cloud_size AS cloudSize,cloud_confirmed_at AS confirmedAt FROM factory_boxes WHERE id=?').get(id) as { status: string; nodeId: string; runId: string | null; cloudBoxId: string | null; cloudSize: string | null; confirmedAt: string | null }
const task = (id: string) => f.db.prepare('SELECT status,factory_state AS factoryState,last_error AS lastError FROM tasks WHERE id=?').get(id) as { status: string; factoryState: string | null; lastError: string | null }

async function link() {
  const { url } = await beginL4ComputeLink(f.env, await f.actor())
  const state = new URL(url).searchParams.get('state')!
  await completeL4ComputeLink(f.env, await f.actor(), 'code-1', state)
  calls.length = 0
  return placement()!.id
}
/** A Task Run with a repository whose Compute Node is the L4 Compute placement, as a Project's repository would name it. */
async function taskRun(taskId: string, nodeId: string, projectId?: string) {
  f.db.prepare("INSERT OR IGNORE INTO task_boards(id,name,created_by) VALUES('l4-board','Factory',?)").run(ids.owner)
  f.db.prepare("INSERT INTO tasks(id,board_id,title,assignee_id,created_by,status) VALUES(?,?,?,?,?,'ready')").run(taskId, 'l4-board', 'Ship ' + taskId, ids.agent, ids.owner)
  const created = await f.run(ids.owner, undefined, taskId)
  // The Project only lends the Task its box size here.
  if (projectId) f.db.prepare('UPDATE tasks SET project_id=? WHERE id=?').run(projectId, taskId)
  const environment = { id: 'l4-env', enabled: true, version: 1, name: 'Afterprompt', computeNodeId: nodeId, sourceRepo: 'inchidev/afterprompt', sourceRepoId: 11, sourceInstallationId: 101,
    workRepo: 'inchidev/afterprompt', workRepoId: 11, workInstallationId: 101, baseBranch: 'main', requiredChecks: [], previewHosts: [], baseSha: 'a'.repeat(40), baseTreeSha: 'b'.repeat(40) }
  f.db.prepare('UPDATE agent_runs SET environment_json=? WHERE id=?').run(JSON.stringify(environment), created.run.id)
  return (await findAgentRun(f.env, created.run.id))!
}

it('links only through the Owner’s own connect step: the nonce comes back or nothing is stored', async () => {
  await expect(beginL4ComputeLink(f.env, await f.actor(ids.member))).rejects.toMatchObject({ statusCode: 403 })
  const { url } = await beginL4ComputeLink(f.env, await f.actor())
  const address = new URL(url)
  expect(address.origin + address.pathname).toBe('https://llll.gg/compute/connect')
  expect(address.searchParams.get('server')).toBe(origin)
  expect(address.searchParams.get('id')).toBe(ids.server)
  const state = address.searchParams.get('state')!
  expect(state).toMatch(/^[a-f0-9]{64}$/u)
  // The Server remembers only a digest of the nonce.
  expect(await readServerSetting(f.env.DB, 'l4_compute_link_state')).not.toContain(state)
  await expect(completeL4ComputeLink(f.env, await f.actor(), 'code-1', 'f'.repeat(64))).rejects.toMatchObject({ statusCode: 403, data: { error: { code: 'compute_link_state' } } })
  expect(calls).toEqual([])
  expect(linkRow()).toBeUndefined()
  // A wrong answer ends that start; the right nonce no longer counts either.
  await expect(completeL4ComputeLink(f.env, await f.actor(), 'code-1', state)).rejects.toMatchObject({ statusCode: 403 })
  expect(await factorySetup(f.env, await f.actor())).toMatchObject({ placements: ['cloudflare'], l4Compute: { linked: false, hosted: false, canConnect: true, account: null } })
})

it('exchanges the code server to server, keeps the Server token encrypted and opens the l4-compute placement', async () => {
  const { url } = await beginL4ComputeLink(f.env, await f.actor())
  const state = new URL(url).searchParams.get('state')!
  expect(await completeL4ComputeLink(f.env, await f.actor(), 'code-1', state)).toEqual({ account: 'owner@example.com' })
  expect(calls).toEqual([{ url: 'https://llll.gg/api/compute/link', method: 'POST', authorization: null, body: { code: 'code-1', serverId: ids.server, serverOrigin: origin } }])
  const row = linkRow()!
  expect(row).toMatchObject({ account: 'owner@example.com', linkedBy: ids.owner })
  expect(JSON.stringify(f.db.prepare('SELECT * FROM l4_compute_link').all())).not.toContain(serverToken)
  expect(await l4ComputeCredential(f.env)).toMatchObject({ kind: 'linked', authorization: `Bearer ${serverToken}`, account: 'owner@example.com' })
  expect(placement()).toMatchObject({ name: 'L4 Compute', enabled: 1 })
  // The same nonce cannot link twice.
  await expect(completeL4ComputeLink(f.env, await f.actor(), 'code-2', state)).rejects.toMatchObject({ statusCode: 403 })
  const setup = await factorySetup(f.env, await f.actor())
  expect(setup.placements).toEqual(['cloudflare', 'l4-compute'])
  expect(setup.l4Compute).toMatchObject({ linked: true, hosted: false, canConnect: false, account: 'owner@example.com', nodeId: placement()!.id,
    status: { creditMicrocents: 12050000000, spentThisMonthMicrocents: 1999000000, spendLimitMicrocents: 5000000000, mayStartBox: true }, statusError: null, pricingUrl: 'https://llll.gg/pricing', accountUrl: 'https://llll.gg/account' })
  expect(calls.filter(call => call.url.endsWith('/api/compute/status'))).toEqual([{ url: 'https://llll.gg/api/compute/status', method: 'GET', authorization: `Bearer ${serverToken}`, body: null }])
  // A second look within the minute shows the cached answer.
  await l4ComputeOverview(f.env)
  expect(calls.filter(call => call.url.endsWith('/api/compute/status'))).toHaveLength(1)
  await expect(beginL4ComputeLink(f.env, await f.actor())).rejects.toMatchObject({ statusCode: 409, data: { error: { code: 'compute_linked' } } })
})

it('shows llll.gg unreachable instead of blocking, and keeps the last answer it had', async () => {
  await link()
  answers.down = true
  const first = await l4ComputeOverview(f.env)
  expect(first).toMatchObject({ linked: true, status: null, statusError: L4_COMPUTE_UNREACHABLE })
  answers.down = false
  expect((await l4ComputeOverview(f.env)).statusError).toBe(L4_COMPUTE_UNREACHABLE)
  f.db.prepare("UPDATE server_settings SET value=json_set(value,'$.at','2020-01-01T00:00:00.000Z') WHERE key='l4_compute_status'").run()
  expect(await l4ComputeOverview(f.env)).toMatchObject({ status: { creditMicrocents: 12050000000 }, statusError: null })
  answers.down = true
  f.db.prepare("UPDATE server_settings SET value=json_set(value,'$.at','2020-01-01T00:00:00.000Z') WHERE key='l4_compute_status'").run()
  expect(await l4ComputeOverview(f.env)).toMatchObject({ status: { creditMicrocents: 12050000000 }, statusError: L4_COMPUTE_UNREACHABLE })
})

it('asks llll.gg for a box on the Task’s first turn with a one-use pairing code bound to that box, at the Project’s size', async () => {
  const nodeId = await link()
  f.db.prepare("INSERT INTO projects(id,name,factory_json,created_by,created_at,updated_at) VALUES('l4-project','Afterprompt',?,?,?,?)").run(JSON.stringify({ compute: { size: 'large' } }), ids.owner, new Date().toISOString(), new Date().toISOString())
  const run = await taskRun('task-l4-1', nodeId, 'l4-project')
  const boxId = await ensureBox(f.env, run, nodeId, L4_COMPUTE_CAPABILITIES)
  expect(calls).toHaveLength(1)
  const [request] = calls
  expect(request).toMatchObject({ url: 'https://llll.gg/api/compute/boxes', method: 'POST', authorization: `Bearer ${serverToken}`, body: { taskId: 'task-l4-1', size: 'large', serverOrigin: origin } })
  const pairingToken = request!.body!.pairingToken as string
  expect(pairingToken).toMatch(/^[a-f0-9]{64}$/u)
  expect(boxRow(boxId)).toMatchObject({ status: 'new', nodeId, runId: run.id, cloudBoxId: 'bx_1', cloudSize: 'large', confirmedAt: null })
  const pairings = f.db.prepare('SELECT token_hash AS tokenHash,box_id AS boxId FROM compute_pairings').all() as Array<{ tokenHash: string; boxId: string | null }>
  expect(pairings).toEqual([{ tokenHash: await factoryHash(pairingToken), boxId: boxId }])
  expect(JSON.stringify(pairings)).not.toContain(pairingToken)
  // The next turn finds the box and asks llll.gg for nothing.
  expect(await ensureBox(f.env, run, nodeId, L4_COMPUTE_CAPABILITIES)).toBe(boxId)
  expect(calls).toHaveLength(1)
  // The box pairs with the code once; it becomes a Node of its own under the placement, the box moves to it, and llll.gg hears the box is confirmed.
  const paired = await pairComputeNode(f.env, pairingToken, { ...dockerCapabilities })
  expect(paired).toMatchObject({ serverId: ids.server })
  expect(calls.slice(1)).toEqual([{ url: 'https://llll.gg/api/compute/boxes/bx_1/confirm', method: 'POST', authorization: `Bearer ${serverToken}`, body: null }])
  expect(boxRow(boxId).confirmedAt).toEqual(expect.any(String))
  expect(f.db.prepare('SELECT name,placement_id AS placementId,box_id AS boxId,enabled FROM compute_nodes WHERE id=?').get(paired.nodeId)).toEqual({ name: 'L4 Compute · Ship task-l4-1', placementId: nodeId, boxId, enabled: 1 })
  expect(boxRow(boxId).nodeId).toBe(paired.nodeId)
  expect(await requireComputeNode(f.env, paired.token)).toMatchObject({ id: paired.nodeId })
  await expect(pairComputeNode(f.env, pairingToken, { ...dockerCapabilities })).rejects.toMatchObject({ statusCode: 403 })
  // Later turns still see the Task's box through its placement.
  expect(await ensureBox(f.env, run, nodeId, L4_COMPUTE_CAPABILITIES)).toBe(boxId)
  expect(calls).toHaveLength(2)
  // The box's Node syncs as any Node does and is handed the turn; a confirmed box is not confirmed again.
  const sync = await computePoll(f.env, paired.nodeId, { operation: 'sync', capacity: { cpu: 2, memoryMiB: 4096, boxes: 1, diskFree: 50000000000 }, boxes: [] }) as { boxes: Array<{ id: string; want: string; turn?: { runId: string } }> }
  expect(sync.boxes).toEqual([expect.objectContaining({ id: boxId, want: 'running', turn: { runId: run.id } })])
  expect(boxRow(boxId).status).toBe('starting')
  expect(calls).toHaveLength(2)
  // The placement itself is a choice for repositories; a box's own Node is listed under it, never chosen.
  const { listComputeNodes } = await import('../../server/utils/compute-nodes')
  expect((await listComputeNodes(f.env, await f.actor())).map(node => ({ id: node.id, placementId: node.placementId }))).toEqual([{ id: nodeId, placementId: null }, { id: paired.nodeId, placementId: nodeId }])
})

it('gives a Task a new box when its box’s own Node is gone, letting the old one go on llll.gg', async () => {
  const nodeId = await link()
  const run = await taskRun('task-l4-lost', nodeId)
  const boxId = await ensureBox(f.env, run, nodeId, L4_COMPUTE_CAPABILITIES)
  const paired = await pairComputeNode(f.env, calls[0]!.body!.pairingToken as string, { ...dockerCapabilities })
  expect(boxRow(boxId).nodeId).toBe(paired.nodeId)
  calls.length = 0
  // Its Node synced a moment ago: the box is alive, nothing is asked.
  expect(await ensureBox(f.env, run, nodeId, L4_COMPUTE_CAPABILITIES)).toBe(boxId)
  expect(calls).toEqual([])
  // Its sandbox went: the Node is silent past the limit. The next turn lets the old box go and asks for a new one.
  f.db.prepare('UPDATE compute_nodes SET last_seen=? WHERE id=?').run(new Date(Date.now() - 10 * 60_000).toISOString(), paired.nodeId)
  answers.box = () => started('bx_2')
  expect(await ensureBox(f.env, run, nodeId, L4_COMPUTE_CAPABILITIES)).toBe(boxId)
  expect(calls.map(call => `${call.method} ${call.url}`)).toEqual(['DELETE https://llll.gg/api/compute/boxes/bx_1', 'POST https://llll.gg/api/compute/boxes'])
  expect(boxRow(boxId)).toMatchObject({ status: 'new', nodeId, cloudBoxId: 'bx_2', confirmedAt: null })
  expect(f.db.prepare('SELECT enabled FROM compute_nodes WHERE id=?').get(paired.nodeId)).toEqual({ enabled: 0 })
  await expect(requireComputeNode(f.env, paired.token)).rejects.toThrow()
  // The new box pairs with its new code.
  const again = await pairComputeNode(f.env, calls[1]!.body!.pairingToken as string, { ...dockerCapabilities })
  expect(boxRow(boxId).nodeId).toBe(again.nodeId)
})

it('confirms the box on the Node’s next sync when llll.gg could not be told at pairing time', async () => {
  const nodeId = await link()
  const run = await taskRun('task-l4-confirm', nodeId)
  const boxId = await ensureBox(f.env, run, nodeId, L4_COMPUTE_CAPABILITIES)
  const pairingToken = calls[0]!.body!.pairingToken as string
  answers.down = true
  const paired = await pairComputeNode(f.env, pairingToken, { ...dockerCapabilities })
  expect(boxRow(boxId)).toMatchObject({ nodeId: paired.nodeId, confirmedAt: null })
  answers.down = false
  calls.length = 0
  const capacity = { cpu: 2, memoryMiB: 4096, boxes: 1, diskFree: 50000000000 }
  await computePoll(f.env, paired.nodeId, { operation: 'sync', capacity, boxes: [] })
  expect(calls).toEqual([{ url: 'https://llll.gg/api/compute/boxes/bx_1/confirm', method: 'POST', authorization: `Bearer ${serverToken}`, body: null }])
  expect(boxRow(boxId).confirmedAt).toEqual(expect.any(String))
  await computePoll(f.env, paired.nodeId, { operation: 'sync', capacity, boxes: [] })
  expect(calls).toHaveLength(1)
})

it('shows a 402 on the Task with where to buy credit, drops the pairing code and retries nothing by itself', async () => {
  const nodeId = await link()
  answers.box = () => Response.json({ error: 'no_credit' }, { status: 402 })
  const run = await taskRun('task-l4-2', nodeId)
  await expect(ensureBox(f.env, run, nodeId, L4_COMPUTE_CAPABILITIES)).rejects.toMatchObject({ statusCode: 403, data: { error: { code: 'compute_credit', message: L4_CREDIT_MESSAGE } } })
  expect(L4_CREDIT_MESSAGE).toContain('https://llll.gg/account')
  expect(calls.filter(call => call.method === 'POST')).toHaveLength(1)
  expect(task('task-l4-2')).toMatchObject({ factoryState: 'l4_credit', lastError: L4_CREDIT_MESSAGE })
  expect(f.db.prepare('SELECT count(*) AS n FROM compute_pairings').get()).toEqual({ n: 0 })
  const box = f.db.prepare("SELECT run_id AS runId,cloud_box_id AS cloudBoxId FROM factory_boxes WHERE task_id='task-l4-2'").get()
  expect(box).toEqual({ runId: null, cloudBoxId: null })
  // Credit bought: the person starts the Task again, and that turn asks again and clears the note.
  answers.box = () => started('bx_2')
  await ensureBox(f.env, run, nodeId, L4_COMPUTE_CAPABILITIES)
  expect(task('task-l4-2')).toMatchObject({ factoryState: null, lastError: null })
})

it('releases the box on llll.gg when the Task is Done, from its Node’s sync or from the Task itself', async () => {
  const nodeId = await link()
  const run = await taskRun('task-l4-3', nodeId)
  const boxId = await ensureBox(f.env, run, nodeId, L4_COMPUTE_CAPABILITIES)
  const pairingToken = calls[0]!.body!.pairingToken as string
  const paired = await pairComputeNode(f.env, pairingToken, { ...dockerCapabilities })
  expect(calls.at(-1)).toMatchObject({ url: 'https://llll.gg/api/compute/boxes/bx_1/confirm', method: 'POST' })
  const capacity = { cpu: 2, memoryMiB: 4096, boxes: 1, diskFree: 50000000000 }
  const first = await computePoll(f.env, paired.nodeId, { operation: 'sync', capacity, boxes: [] }) as { boxes: Array<{ id: string; lease: string }> }
  const lease = first.boxes[0]!.lease
  // The Task is Done and its Run over: the Node's next sync releases the box, and llll.gg is told.
  f.db.prepare("UPDATE tasks SET status='done' WHERE id='task-l4-3'").run()
  f.db.prepare("UPDATE agent_runs SET status='completed' WHERE id=?").run(run.id)
  calls.length = 0
  const second = await computePoll(f.env, paired.nodeId, { operation: 'sync', capacity, boxes: [{ id: boxId, lease, state: 'running', runId: run.id, runtimeMs: 1000 }] }) as { boxes: Array<{ id: string; want: string }> }
  expect(second.boxes).toEqual([expect.objectContaining({ id: boxId, want: 'released' })])
  expect(calls).toEqual([{ url: 'https://llll.gg/api/compute/boxes/bx_1', method: 'DELETE', authorization: `Bearer ${serverToken}`, body: null }])
  expect(boxRow(boxId)).toMatchObject({ status: 'released', runId: null })
  expect(f.db.prepare('SELECT enabled FROM compute_nodes WHERE id=?').get(paired.nodeId)).toEqual({ enabled: 0 })
  await expect(requireComputeNode(f.env, paired.token)).rejects.toMatchObject({ statusCode: 403 })
  // A released box's Node is no longer listed; the placement is.
  const { listComputeNodes } = await import('../../server/utils/compute-nodes')
  expect((await listComputeNodes(f.env, await f.actor())).map(node => node.id)).toEqual([nodeId])

  // A Task marked Done while its Node is silent: the Task's own change releases the box.
  const other = await taskRun('task-l4-4', nodeId)
  answers.box = () => started('bx_4')
  const otherBox = await ensureBox(f.env, other, nodeId, L4_COMPUTE_CAPABILITIES)
  calls.length = 0
  f.db.prepare("UPDATE tasks SET status='done' WHERE id='task-l4-4'").run()
  // Its Run still runs: the box stays until the turn ends.
  expect(await releaseL4BoxesForTasks(f.env, ['task-l4-4'])).toEqual([])
  f.db.prepare("UPDATE agent_runs SET status='completed' WHERE id=?").run(other.id)
  expect(await releaseL4BoxesForTasks(f.env, ['task-l4-4'])).toEqual([otherBox])
  expect(calls).toEqual([{ url: 'https://llll.gg/api/compute/boxes/bx_4', method: 'DELETE', authorization: `Bearer ${serverToken}`, body: null }])
  expect(boxRow(otherBox).status).toBe('released')
  expect(f.db.prepare('SELECT count(*) AS n FROM compute_pairings').get()).toEqual({ n: 0 })
})

it('disconnects: every box is released on llll.gg, the token is forgotten and the placement pauses', async () => {
  const nodeId = await link()
  const run = await taskRun('task-l4-5', nodeId)
  const boxId = await ensureBox(f.env, run, nodeId, L4_COMPUTE_CAPABILITIES)
  calls.length = 0
  await expect(disconnectL4Compute(f.env, await f.actor(ids.member))).rejects.toMatchObject({ statusCode: 403 })
  await disconnectL4Compute(f.env, await f.actor())
  expect(calls).toEqual([{ url: 'https://llll.gg/api/compute/boxes/bx_1', method: 'DELETE', authorization: `Bearer ${serverToken}`, body: null }])
  expect(boxRow(boxId).status).toBe('released')
  expect(linkRow()).toBeUndefined()
  expect(placement()).toMatchObject({ id: nodeId, enabled: 0 })
  expect(await l4ComputeOverview(f.env)).toMatchObject({ linked: false, canConnect: true, status: null })
  // Linking again revives the same placement, so repositories that chose it work again.
  await link()
  expect(placement()).toMatchObject({ id: nodeId, enabled: 1 })
})

it('treats a Server hosted on L4 Cloud as linked, speaking to llll.gg with its CLOUD_SECRET', async () => {
  Object.assign(f.env, { LLLL_RUNTIME: 'cloud', CLOUD_SECRET: 'hosted-secret-0123456789abcdef' })
  const overview = await l4ComputeOverview(f.env)
  expect(overview).toMatchObject({ linked: true, hosted: true, canConnect: false, account: null, status: { creditMicrocents: 12050000000 } })
  expect(calls).toEqual([{ url: 'https://llll.gg/api/compute/status', method: 'GET', authorization: `Bearer l4h.${ids.server}.hosted-secret-0123456789abcdef`, body: null }])
  expect(linkRow()).toBeUndefined()
  const nodeId = placement()!.id
  expect(overview.nodeId).toBe(nodeId)
  await expect(beginL4ComputeLink(f.env, await f.actor())).rejects.toMatchObject({ statusCode: 409, data: { error: { code: 'compute_hosted' } } })
  await expect(disconnectL4Compute(f.env, await f.actor())).rejects.toMatchObject({ statusCode: 409 })
  const run = await taskRun('task-l4-6', nodeId)
  calls.length = 0
  await ensureBox(f.env, run, nodeId, L4_COMPUTE_CAPABILITIES)
  expect(calls).toEqual([expect.objectContaining({ url: 'https://llll.gg/api/compute/boxes', method: 'POST', authorization: `Bearer l4h.${ids.server}.hosted-secret-0123456789abcdef` })])
  expect((await factorySetup(f.env, await f.actor())).placements).toEqual(['cloudflare', 'l4-compute'])
})

it('does not ask llll.gg for anything while the Server is not linked', async () => {
  const run = await taskRun('task-l4-7', (await (async () => {
    // A placement row left from an earlier link that was disconnected.
    f.db.prepare('INSERT INTO compute_nodes(id,name,token_hash,capabilities_json,enabled,created_by,created_at) VALUES(?,?,?,?,0,?,?)')
      .run('00000000-0000-4000-8000-0000000000aa', 'L4 Compute', await factoryHash('x'), JSON.stringify(L4_COMPUTE_CAPABILITIES), ids.owner, new Date().toISOString())
    return '00000000-0000-4000-8000-0000000000aa'
  })()))
  await expect(ensureBox(f.env, run, '00000000-0000-4000-8000-0000000000aa', L4_COMPUTE_CAPABILITIES)).rejects.toMatchObject({ statusCode: 403, data: { error: { code: 'compute_unlinked' } } })
  expect(calls).toEqual([])
})
