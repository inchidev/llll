import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mcpFixture, ids } from '../helpers/outbound-mcp'
import { ALL_PERMISSIONS } from '../../shared/permissions'
import { factoryHash } from '../../server/utils/factory-authority'
import * as githubAgent from '../../server/utils/github-agent-client'
import { agentGateway } from '../../server/utils/agent-gateway'
import { findAgentRun } from '../../server/utils/agent-run-service'
import { ensureBox, releaseBoxTurn } from '../../server/utils/factory-boxes'
import { BoxOutbound, type BoxEgress } from '../../workers/factory-outbound'
import { CLOUD_BOX_IDLE_MS, FactoryComputeDurableObject } from '../../workers/factory-compute'
import { factoryRepositoryName } from '../../shared/software-factory'
import type { AgentRun, RuntimeEvent } from '../../shared/agent-execution'
import { configureCloudflareFactory } from '../../server/utils/factory-setup'
import { beginUnusedFactoryRepair } from '../../packages/deployment-core/src/factory-repair'
import { cloudCodeBridge } from '../../workers/factory-code-bridge'

vi.mock('cloudflare:workers', () => ({
  WorkerEntrypoint: class { constructor(protected ctx: unknown, protected env: unknown) {} },
  DurableObject: class { constructor(protected ctx: unknown, protected env: unknown) {} },
}))
// The gateway is served in-process; this test sees only what reaches it.
vi.mock('../../server/utils/agent-gateway', async original => ({ ...await original<typeof import('../../server/utils/agent-gateway')>(),
  agentGateway: vi.fn(async () => Response.json({ ack: 0, cancel: false, steer: [] })) }))

const nodeId = '00000000-0000-4000-8000-000000000099'
const image = 'registry.cloudflare.com/account/factory@sha256:' + 'a'.repeat(64)
const capabilities = { provider: 'cloudflare-containers', diskBytes: 8000000000, docker: false, durableDisk: false, isolation: 'container-vm', image,
  capacity: { cpu: 0.5, memoryMiB: 4096, boxes: 1 }, protocol: 2, memoryMiB: 4096, cpu: 0.5, processLimit: 128, codeBytes: 500000000, timeoutMs: 120000 }
const config = { name: 'Original upstream', computeNodeId: nodeId, sourceRepo: 'inchidev/afterprompt', sourceRepoId: 11, sourceInstallationId: 101,
  workRepo: 'inchidev/afterprompt', workRepoId: 11, workInstallationId: 101, baseBranch: 'main', requiredChecks: ['test'], previewHosts: [] }
const codeRemote = 'https://account.artifacts.cloudflare.net/git/server/task.git', source = 'https://github.com/inchidev/afterprompt.git'
const submission = (runId: string) => ({ runId, modelGateway: { url: `https://server.example/api/agent-runs/${runId}/gateway/v1`, token: 'run-capability-stays-in-the-run', model: 'm' }, computer: true, box: true })
let f: ReturnType<typeof mcpFixture>, run: AgentRun
const network = vi.fn(async (..._args: unknown[]) => new Response('Provider Git response'))
const results: Array<{ runId: string; result?: RuntimeEvent }> = []
const boxObjects = new Map<string, FactoryComputeDurableObject>()
const handles: Array<{ revokeToken: ReturnType<typeof vi.fn>; [Symbol.dispose]: ReturnType<typeof vi.fn> }> = []
let tokens = 0
const artifacts = {
  create: vi.fn(async (_name: string, _options?: unknown) => ({ token: 'initial-code-token' })),
  get: vi.fn(async () => {
    const handle = { info: vi.fn(async () => ({ remote: codeRemote })), createToken: vi.fn(async (scope: string) => ({ id: 'token-' + ++tokens, plaintext: `${scope}-Task-code-capability` })),
      revokeToken: vi.fn(async () => {}), [Symbol.dispose]: vi.fn() }
    handles.push(handle); return handle
  }),
  delete: vi.fn(async (_name: string) => {}),
}

/** A Task Run of the fixture's repository; a second Run of the same Task reuses its box. */
async function taskRun(taskId: string) {
  if (!f.db.prepare('SELECT 1 FROM tasks WHERE id=?').get(taskId)) f.db.prepare("INSERT INTO tasks(id,board_id,title,assignee_id,created_by,status) VALUES(?,?,?,?,?,'ready')").run(taskId, 'factory-board', 'Repair ' + taskId, ids.agent, ids.owner)
  // The fixture has no Git connection: the Run's repository snapshot is written here, as the Server would pin it.
  f.db.prepare('UPDATE tasks SET environment_id=NULL WHERE id=?').run(taskId)
  const created = await f.run(ids.owner, undefined, taskId)
  f.db.prepare('UPDATE tasks SET environment_id=? WHERE id=?').run('factory-env', taskId)
  f.db.prepare('UPDATE agent_runs SET environment_json=?,mandate_json=? WHERE id=?')
    .run(JSON.stringify({ ...config, id: 'factory-env', enabled: true, version: 1, baseSha: 'a'.repeat(40), baseTreeSha: 'b'.repeat(40) }),
      JSON.stringify({ ...JSON.parse(created.run.mandateJson), environmentId: 'factory-env', environmentVersion: 1 }), created.run.id)
  return (await findAgentRun(f.env, created.run.id))!
}

beforeEach(async () => {
  f = mcpFixture()
  results.length = 0; handles.length = 0; boxObjects.clear(); tokens = 0
  f.db.prepare('UPDATE roles SET permissions_bitmask=? WHERE id=?').run(ALL_PERMISSIONS, ids.agentRole)
  f.db.prepare('INSERT INTO task_boards(id,name,created_by) VALUES(?,?,?)').run('factory-board', 'Factory', ids.owner)
  f.db.prepare('INSERT INTO compute_nodes(id,name,token_hash,capabilities_json,last_seen,created_by,created_at) VALUES(?,?,?,?,?,?,?)')
    .run(nodeId, 'Cloudflare', await factoryHash('unexposed-node-token'), JSON.stringify(capabilities), new Date().toISOString(), ids.owner, new Date().toISOString())
  f.db.prepare('INSERT INTO agent_environments(id,config_json,created_by,created_at,updated_at) VALUES(?,?,?,?,?)')
    .run('factory-env', JSON.stringify(config), ids.owner, new Date().toISOString(), new Date().toISOString())
  run = await taskRun('factory-task')
  Object.assign(f.env, {
    PUBLIC_ORIGIN: 'https://server.example', FACTORY_IMAGE: image, FACTORY_CODE: artifacts,
    FACTORY_COMPUTE: { idFromName: (name: string) => name, getByName: (name: string) => boxObjects.get(name) ?? { wake: async () => {} } },
    AGENT_RUN_DO: { getByName: () => ({
      boxSubmission: async (runId: string) => submission(runId),
      boxEvents: async (runId: string, _from: number, _events: RuntimeEvent[], result?: RuntimeEvent) => { results.push({ runId, result }); return { ack: 0, cancel: false, steer: [] } },
      wake: async () => {} }) },
    CHANNEL_DO: { getByName: () => ({ fanout: async () => {} }) },
  })
  vi.spyOn(githubAgent, 'githubSourceGrant').mockResolvedValue('upstream-read-only-capability')
  vi.stubGlobal('scheduler', { wait: async () => {} })
  // workerd accepts streamed request bodies directly; Node's Undici needs its duplex hint.
  const NativeRequest = globalThis.Request
  vi.stubGlobal('Request', class extends NativeRequest {
    constructor(input: ConstructorParameters<typeof NativeRequest>[0], init?: RequestInit) { super(input, { ...init, duplex: 'half' } as RequestInit) }
  })
  network.mockClear(); vi.mocked(agentGateway).mockClear(); vi.stubGlobal('fetch', network)
  for (const mock of [artifacts.create, artifacts.get, artifacts.delete]) mock.mockClear()
})
afterEach(() => { f.db.close(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

const boxRow = (id: string) => f.db.prepare('SELECT status,lease_token AS leaseToken,run_id AS runId,checkpoint_sha AS checkpointSha FROM factory_boxes WHERE id=?').get(id) as { status: string; leaseToken: string | null; runId: string | null; checkpointSha: string | null }
/** A box its Node holds under a live lease, as the Durable Object leaves it once started. */
async function leasedBox(lease = 'b'.repeat(64)) {
  const id = await ensureBox(f.env, run, nodeId)
  f.db.prepare("UPDATE factory_boxes SET status='running',lease_token=?,lease_until=? WHERE id=?").run(lease, new Date(Date.now() + 60000).toISOString(), id)
  return { id, lease }
}
function outbound(boxId: string, lease: string, grant: Omit<BoxEgress, 'boxId' | 'lease'> = {}) {
  return new BoxOutbound({ props: { boxId, lease, ...grant }, waitUntil: () => {} } as never, f.env)
}
const request = (url: string, method = 'GET') => new Request(url, { method, headers: { Authorization: 'Bearer attacker-selected', Cookie: 'private-cookie', 'X-Test': 'safe-header' }, ...(method === 'POST' ? { body: 'bounded Git body' } : {}) })

it('serves its own Run’s gateway in this Worker and never sends it to the network', async () => {
  const { id, lease } = await leasedBox()
  const gateway = `https://server.example/api/agent-runs/${run.id}/gateway/events`
  const answer = await outbound(id, lease).fetch(new Request(gateway, { method: 'POST', headers: { Authorization: 'Bearer run-capability', Cookie: 'private-cookie' }, body: '{"from":0,"events":[]}' }))
  expect(answer.status).toBe(200)
  expect(agentGateway).toHaveBeenCalledWith(expect.any(Request), f.env, run.id, 'events', expect.any(Function))
  const forwarded = vi.mocked(agentGateway).mock.calls[0]![0]
  expect(forwarded.headers.get('Authorization')).toBe('Bearer run-capability')
  expect(forwarded.headers.has('cookie')).toBe(false)
  const other = await taskRun('another-task')
  for (const url of [gateway.replace(run.id, other.id), gateway.replace('server.example', 'attacker.example'), gateway + '?from=0', gateway.replace('https:', 'http:'), 'https://server.example/api/agent-runs']) {
    expect((await outbound(id, lease).fetch(request(url, 'POST'))).status).toBe(403)
  }
  expect(agentGateway).toHaveBeenCalledOnce()
  expect(network).not.toHaveBeenCalled()
})

it('adds the source credential on the way out, for original-repository Git reads only', async () => {
  const { id, lease } = await leasedBox()
  const worker = outbound(id, lease, { source: { remote: source, token: 'single-repository-read-token' } })
  expect((await worker.fetch(request(source + '/info/refs?service=git-upload-pack'))).status).toBe(200)
  const forwarded = network.mock.calls[0]![0] as Request
  expect(forwarded.headers.get('Authorization')).toBe('Basic ' + btoa('x-access-token:single-repository-read-token'))
  expect(forwarded.headers.has('cookie')).toBe(false)
  expect(forwarded.redirect).toBe('manual')
  for (const url of [source + '/git-receive-pack', 'https://github.com/other/private.git/info/refs?service=git-upload-pack', 'https://attacker.example/info/refs?service=git-upload-pack']) {
    expect((await worker.fetch(request(url, 'POST'))).status).toBe(403)
  }
  expect(network).toHaveBeenCalledTimes(1)
})

it.each([false, true])('scopes the Artifacts token to the Task’s own repository and one Git service (write %s)', async write => {
  const { id, lease } = await leasedBox()
  const worker = outbound(id, lease, { storage: { remote: codeRemote, token: 'private-working-repo-capability', write } }), service = write ? 'git-receive-pack' : 'git-upload-pack'
  expect((await worker.fetch(request(codeRemote + '/info/refs?service=' + service))).status).toBe(200)
  expect((await worker.fetch(request(codeRemote + '/' + service, 'POST'))).status).toBe(200)
  expect((network.mock.calls[0]![0] as Request).headers.get('Authorization')).toBe('Bearer private-working-repo-capability')
  const otherService = write ? 'git-upload-pack' : 'git-receive-pack'
  for (const url of [codeRemote.replace('/task.git', '/another-task.git') + '/info/refs?service=' + service,
    codeRemote + '/info/refs?service=' + otherService, codeRemote + '/' + otherService,
    codeRemote.replace('https:', 'http:'), codeRemote.replace('.net', '.net:8443')]) {
    expect((await worker.fetch(request(url))).status).toBe(403)
  }
  expect(network).toHaveBeenCalledTimes(2)
})

it('refuses a redirect without forwarding the credential to another destination', async () => {
  const { id, lease } = await leasedBox()
  network.mockResolvedValueOnce(new Response(null, { status: 307, headers: { Location: 'https://attacker.example/steal' } }))
  const result = await outbound(id, lease, { storage: { remote: codeRemote, token: 'private-working-repo-capability', write: false } }).fetch(request(codeRemote + '/info/refs?service=git-upload-pack'))
  expect(result.status).toBe(502)
  expect(await result.text()).not.toContain('private-working-repo-capability')
  expect(network).toHaveBeenCalledTimes(1)
})

/** The start of a receive-pack request, as Git writes it: one pkt-line per ref update, a flush, then the pack. */
const pkt = (line: string) => (line.length + 4).toString(16).padStart(4, '0') + line
const pushBody = (...commands: string[]) => commands.map((command, index) => pkt(index ? command + '\n' : command + '\0report-status side-band-64k agent=git/2.47\n')).join('') + '0000PACK-the-pack-itself'
const pushRequest = (body: string) => new Request(source + '/git-receive-pack', { method: 'POST', headers: { 'Content-Type': 'application/x-git-receive-pack-request' }, body })

it('lets a box push only the approved commit to its own branch, adding the push credential itself', async () => {
  const { id, lease } = await leasedBox()
  const approved = 'c'.repeat(40), ref = `refs/heads/l4-agent/${id}`, zero = '0'.repeat(40)
  const worker = outbound(id, lease, { push: { remote: source, token: 'single-repository-push-token', ref, sha: approved } })
  expect((await worker.fetch(request(source + '/info/refs?service=git-receive-pack'))).status).toBe(200)
  expect((network.mock.calls[0]![0] as Request).headers.get('Authorization')).toBe('Basic ' + btoa('x-access-token:single-repository-push-token'))
  const allowed = pushBody(`${zero} ${approved} ${ref}`)
  expect((await worker.fetch(pushRequest(allowed))).status).toBe(200)
  const forwarded = network.mock.calls[1]![0] as Request
  expect(forwarded.headers.get('Authorization')).toBe('Basic ' + btoa('x-access-token:single-repository-push-token'))
  expect(await forwarded.text()).toBe(allowed)
  for (const [body, reason] of [
    [pushBody(`${zero} ${approved} refs/heads/main`), 'Task’s own branch'],
    [pushBody(`${zero} ${'d'.repeat(40)} ${ref}`), 'approved commit'],
    [pushBody(`${approved} ${zero} ${ref}`), 'deleted'],
    [pushBody(`${zero} ${approved} ${ref}`, `${zero} ${approved} refs/heads/main`), 'one ref update'],
    [pkt(`${zero} ${approved} ${ref}\0report-status push-options\n`) + '0000PACK', 'push-options'],
    [pkt(`push-cert\0report-status\n`) + '0000', 'Signed'],
  ] as const) {
    const refused = await worker.fetch(pushRequest(body))
    expect(refused.status, reason).toBe(403)
    expect(await refused.text()).toContain(reason)
  }
  // Another repository, or the same push without a grant, never leaves.
  expect((await worker.fetch(new Request('https://github.com/other/private.git/git-receive-pack', { method: 'POST', body: allowed }))).status).toBe(403)
  expect((await outbound(id, lease).fetch(pushRequest(allowed))).status).toBe(403)
  expect((await outbound(id, lease, { push: { remote: source, token: 't', ref: 'refs/heads/l4-agent/' + crypto.randomUUID(), sha: approved } }).fetch(pushRequest(allowed))).status).toBe(403)
  expect(network).toHaveBeenCalledTimes(2)
})

it.each(['expired lease', 'another lease', 'paused Node', 'released box'])('refuses every destination after a %s', async change => {
  const { id, lease } = await leasedBox()
  if (change === 'expired lease') f.db.prepare("UPDATE factory_boxes SET lease_until='2000-01-01' WHERE id=?").run(id)
  if (change === 'another lease') f.db.prepare('UPDATE factory_boxes SET lease_token=? WHERE id=?').run('c'.repeat(64), id)
  if (change === 'paused Node') f.db.prepare('UPDATE compute_nodes SET enabled=0 WHERE id=?').run(nodeId)
  if (change === 'released box') f.db.prepare("UPDATE factory_boxes SET status='released' WHERE id=?").run(id)
  const worker = outbound(id, lease, { storage: { remote: codeRemote, token: 'private-working-repo-capability', write: true } })
  expect((await worker.fetch(request(codeRemote + '/info/refs?service=git-receive-pack'))).status).toBe(403)
  expect((await worker.fetch(request(`https://server.example/api/agent-runs/${run.id}/gateway/tools`, 'POST'))).status).toBe(403)
  expect(network).not.toHaveBeenCalled()
  expect(agentGateway).not.toHaveBeenCalled()
})

it('keeps every other host closed and never attaches a credential to it', async () => {
  const { id, lease } = await leasedBox()
  const worker = outbound(id, lease, { source: { remote: source, token: 'single-repository-read-token' }, storage: { remote: codeRemote, token: 'private-working-repo-capability', write: true } })
  for (const url of ['https://registry.npmjs.org/package', 'https://api.telegram.org/bot/getMe', 'https://attacker.example/source']) {
    expect((await worker.fetch(request(url))).status).toBe(403)
  }
  expect(network).not.toHaveBeenCalled()
})

const kind = (props: BoxEgress) => props.source ? 'source' : props.storage ? props.storage.write ? 'checkpoint' : 'restore' : 'box'
/** One box's Durable Object with a fake container that runs the box's control socket and its trusted helper. */
function boxObject(id: string) {
  const values = new Map<string, unknown>(), events: string[] = [], phases: BoxEgress[] = []
  const helper: Array<Record<string, unknown>> = [], controls: Array<Record<string, unknown>> = []
  const state = { running: false, image, turn: null as string | null, checkout: false, checkpoints: 0, checkpointFails: false, alarm: null as number | null }
  const container = {
    get running() { return state.running },
    start: vi.fn((_options: { entrypoint: string[]; enableInternet: boolean; env: Record<string, string> }) => { state.running = true; events.push('start') }),
    destroy: vi.fn(async () => { state.running = false; state.turn = null; state.checkout = false; events.push('destroy') }),
    setInactivityTimeout: vi.fn(async () => {}),
    inspect: vi.fn(async () => ({ image: state.image })),
    interceptOutboundHttps: vi.fn(async (_host: string, binding: { props: BoxEgress }) => { phases.push(binding.props) }),
    exec: vi.fn(async (argv: string[], options: { stdin?: ReadableStream; user?: string; env?: Record<string, string> }) => {
      expect(options.user).toBe('1000:1000')
      const input = JSON.parse(await new Response(options.stdin).text()) as Record<string, unknown>
      const reply = (value: unknown, line = true) => ({ exitCode: Promise.resolve(0), stdout: new Response(JSON.stringify(value) + (line ? '\n' : '')).body, stderr: new Response('').body })
      if (argv.includes('/opt/agent/src/control.mjs')) {
        controls.push(input)
        if (input.op === 'health') return reply({ status: state.turn ? 'running' : 'ready', ...(state.turn ? { runId: state.turn } : {}), checkout: state.checkout })
        if (input.op === 'turn') { state.turn = (input.submission as { runId: string }).runId; return reply({ accepted: true }) }
        return reply({ ok: state.turn === input.runId })
      }
      expect(argv[0]).toBe('/usr/bin/prlimit')
      expect(argv.at(-1)).toBe(cloudCodeBridge)
      expect(options.env).toMatchObject({ LLLL_BOX_ROOT: '/work' })
      helper.push(input)
      const phase = kind(phases.at(-1)!)
      if (input.operation === 'bootstrap') { expect(phase).toBe('source'); state.checkout = true; events.push('source-cloned'); return reply({ ok: true }, false) }
      if (input.operation === 'restore') { expect(phase).toBe('restore'); state.checkout = true; events.push('restored'); return reply({ ok: true }, false) }
      expect(phase).toBe('checkpoint'); events.push('checkpoint')
      state.checkpoints++
      return reply(state.checkpointFails ? { ok: false } : { ok: true, checkpoint: (state.checkpoints === 1 ? 'c' : 'd').repeat(40), head: 'e'.repeat(40), tree: 'f'.repeat(40) }, false)
    }),
  }
  const storage = {
    get: async (key: string) => structuredClone(values.get(key)),
    put: async (key: string, value: unknown) => { values.set(key, structuredClone(value)) },
    delete: async (key: string) => values.delete(key),
    deleteAll: async () => { values.clear() },
    setAlarm: async (at: number) => { state.alarm = at },
    getAlarm: async () => state.alarm,
    deleteAlarm: async () => { state.alarm = null },
  }
  const ctx = { id: { equals: (other: unknown) => other === `box:${id}` }, storage, container, exports: { BoxOutbound: (binding: { props: BoxEgress }) => binding } }
  const instance = new FactoryComputeDurableObject(ctx as never, f.env)
  boxObjects.set(`box:${id}`, instance)
  /** The runtime clears an alarm as it fires it. */
  const tick = async () => { state.alarm = null; await instance.alarm() }
  const turns = () => controls.filter(control => control.op === 'turn')
  const idle = () => values.set('box', { ...values.get('box') as object, lastActive: Date.now() - CLOUD_BOX_IDLE_MS - 1000 })
  return { instance, values, events, phases, helper, controls, state, container, tick, turns, idle }
}
/** The Run's turn goes to the Task's box: the Run's Durable Object wakes the box's on submission. */
async function startedBox() {
  const id = await ensureBox(f.env, run, nodeId)
  const box = boxObject(id)
  await box.instance.wake(id)
  await box.tick()
  return { id, box }
}
const finishTurn = async (box: ReturnType<typeof boxObject>, runId = run.id) => {
  box.state.turn = null
  f.db.prepare("UPDATE agent_runs SET status='completed' WHERE id=?").run(runId)
  await box.tick()
}

it('starts the box for its first turn, clones the pinned source once and hands the turn to its control socket', async () => {
  const { id, box } = await startedBox()
  const row = boxRow(id)
  expect(row).toMatchObject({ status: 'starting', runId: run.id })
  expect(row.leaseToken).toMatch(/^[a-f0-9]{64}$/u)
  expect(box.container.start).toHaveBeenCalledOnce()
  const options = box.container.start.mock.calls[0]![0]
  expect(options.enableInternet).toBe(false)
  expect(options.entrypoint.slice(0, 3)).toEqual(['/usr/bin/setpriv', '--reuid=1000', '--regid=1000'])
  expect(options.entrypoint.at(-1)).toBe('/opt/agent/src/box.mjs')
  expect(box.phases.map(kind)).toEqual(['box', 'source', 'box'])
  expect(box.phases.every(props => props.boxId === id && props.lease === row.leaseToken)).toBe(true)
  expect(box.phases[1]!.source).toEqual({ remote: source, token: 'upstream-read-only-capability' })
  expect(artifacts.create).toHaveBeenCalledWith(factoryRepositoryName(ids.server, id), expect.anything())
  expect(handles[0]!.revokeToken).toHaveBeenCalledWith('initial-code-token')
  expect(network).toHaveBeenCalledWith('https://api.github.com/installation/token', expect.objectContaining({ method: 'DELETE' }))
  expect(box.turns()).toEqual([{ op: 'turn', submission: submission(run.id) }])
  // Neither the container's start nor a helper ever sees a credential: the outbound Worker adds them.
  expect(JSON.stringify([options, box.helper])).not.toContain('capability')
  expect(box.values.get('checkpoint')).toBeUndefined()
  expect(box.state.alarm).toBeGreaterThan(Date.now())

  // The next sync reports the turn and keeps the lease; the box is not started or handed the turn again.
  await box.tick()
  expect(boxRow(id)).toMatchObject({ status: 'running', leaseToken: row.leaseToken })
  expect(box.container.start).toHaveBeenCalledOnce()
  expect(box.turns()).toHaveLength(1)
})

it('checkpoints when the turn ends, stops when idle and restores the next turn from Artifacts', async () => {
  const { id, box } = await startedBox()
  await finishTurn(box)
  expect(box.events.filter(event => event === 'checkpoint')).toHaveLength(1)
  expect(box.phases.slice(-2).map(kind)).toEqual(['checkpoint', 'box'])
  const repository = factoryRepositoryName(ids.server, id)
  expect(box.values.get('checkpoint')).toMatchObject({ sha: 'c'.repeat(40), repository, image })
  expect(boxRow(id)).toMatchObject({ status: 'idle', checkpointSha: 'c'.repeat(40), runId: null })
  expect(box.container.destroy).not.toHaveBeenCalled()
  expect(handles.every(handle => handle[Symbol.dispose].mock.calls.length === 1)).toBe(true)

  box.idle()
  await box.tick()
  expect(box.container.destroy).toHaveBeenCalledOnce()
  // Nothing changed since the turn's checkpoint.
  expect(box.state.checkpoints).toBe(1)
  expect(boxRow(id)).toMatchObject({ status: 'stopped', leaseToken: null })
  expect(box.state.alarm).toBeNull()

  const next = await taskRun('factory-task')
  expect(await ensureBox(f.env, next, nodeId)).toBe(id)
  await box.instance.wake(id)
  await box.tick()
  expect(box.container.start).toHaveBeenCalledTimes(2)
  expect(box.phases.slice(-3).map(kind)).toEqual(['box', 'restore', 'box'])
  expect(box.helper.find(input => input.operation === 'restore')).toMatchObject({ checkpoint: 'c'.repeat(40), baseSha: 'a'.repeat(40) })
  expect(artifacts.create).toHaveBeenCalledOnce()
  expect(box.turns().map(turn => (turn.submission as { runId: string }).runId)).toEqual([run.id, next.id])

  await finishTurn(box, next.id)
  expect(box.values.get('checkpoint')).toMatchObject({ sha: 'd'.repeat(40) })
  expect(box.helper.at(-1)).toMatchObject({ operation: 'checkpoint', checkpoint: 'c'.repeat(40) })
})

it('cancels a turn through the box’s control socket', async () => {
  const { box } = await startedBox()
  // The Run's DELETE releases the turn and wakes the box at once.
  await releaseBoxTurn(f.env, run.id)
  expect(box.state.alarm).toBeLessThanOrEqual(Date.now())
  await box.tick()
  expect(box.controls.at(-1)).toEqual({ op: 'cancel', runId: run.id })
})

it('ends a turn whose container is gone instead of running it again', async () => {
  const { box } = await startedBox()
  box.state.running = false
  await box.tick()
  expect(results).toContainEqual({ runId: run.id, result: { type: 'error', message: expect.stringContaining('stopped during this turn') } })
  expect(box.container.start).toHaveBeenCalledOnce()
  expect(box.turns()).toHaveLength(1)
})

it.each(['start', 'image', 'source'] as const)('ends the turn when its box cannot start (%s) and does not start it again for that turn', async failure => {
  if (failure === 'source') vi.mocked(githubAgent.githubSourceGrant).mockRejectedValueOnce(new Error('private-provider-diagnostic'))
  const id = await ensureBox(f.env, run, nodeId)
  const box = boxObject(id)
  if (failure === 'start') box.container.start.mockImplementationOnce(() => { throw new Error('private-provider-diagnostic') })
  if (failure === 'image') box.state.image = 'registry.cloudflare.com/account/changed@sha256:' + 'f'.repeat(64)
  await box.instance.wake(id)
  await box.tick()
  expect(results).toEqual([{ runId: run.id, result: { type: 'error', message: expect.stringContaining('could not start') } }])
  expect(JSON.stringify(results)).not.toContain('private-provider-diagnostic')
  expect(box.helper).toEqual([])
  expect(artifacts.create).not.toHaveBeenCalled()
  expect(box.turns()).toEqual([])
  await box.instance.wake(id)
  await box.tick()
  expect(box.container.start).toHaveBeenCalledOnce()
  expect(results).toHaveLength(1)
})

it('waits for a free box within the Node’s capacity and starts when one stops', async () => {
  const first = await startedBox()
  const other = await taskRun('second-task'), otherId = await ensureBox(f.env, other, nodeId)
  const second = boxObject(otherId)
  await second.instance.wake(otherId)
  await second.tick()
  expect(second.container.start).not.toHaveBeenCalled()
  expect(boxRow(otherId).status).toBe('queued')
  expect(second.state.alarm).toBeGreaterThan(Date.now())

  await finishTurn(first.box)
  first.box.idle()
  await first.box.tick()
  expect(boxRow(first.id).status).toBe('stopped')
  // The stopping box's sync admitted the waiting one and woke its object.
  expect(boxRow(otherId).status).toBe('starting')
  expect(second.state.alarm).toBeLessThanOrEqual(Date.now())
  await second.tick()
  expect(second.container.start).toHaveBeenCalledOnce()
  expect(second.turns().map(turn => (turn.submission as { runId: string }).runId)).toEqual([other.id])
})

it('stops with a paused Node and keeps its checkpoint', async () => {
  const { id, box } = await startedBox()
  await finishTurn(box)
  f.db.prepare('UPDATE compute_nodes SET enabled=0 WHERE id=?').run(nodeId)
  await box.tick()
  expect(box.container.destroy).toHaveBeenCalledOnce()
  expect(boxRow(id)).toMatchObject({ status: 'stopped', leaseToken: null, checkpointSha: 'c'.repeat(40) })
  expect(box.values.get('checkpoint')).toMatchObject({ sha: 'c'.repeat(40) })
  expect(artifacts.delete).not.toHaveBeenCalled()
})

it('releases the container and the Task’s code repository when the Task is Done', async () => {
  const { id, box } = await startedBox()
  await finishTurn(box)
  f.db.prepare("UPDATE tasks SET status='done' WHERE id='factory-task'").run()
  await box.tick()
  expect(boxRow(id).status).toBe('released')
  expect(box.container.destroy).toHaveBeenCalledOnce()
  expect(artifacts.delete).toHaveBeenCalledWith(factoryRepositoryName(ids.server, id))
  expect(box.values.size).toBe(0)
  expect(box.state.alarm).toBeNull()
})

it('refuses a wake meant for another box’s object', async () => {
  const id = await ensureBox(f.env, run, nodeId)
  const box = boxObject(id)
  await expect(box.instance.wake('00000000-0000-4000-8000-0000000000aa')).rejects.toThrow('Invalid box scope')
  expect(box.values.size).toBe(0)
  expect(box.state.alarm).toBeNull()
})

async function provisioningFixture() {
  const { createHash } = await import('node:crypto')
  const sha = (value: string) => createHash('sha256').update(value).digest('hex')
  const accountId = 'a'.repeat(32), workerName = 'llll-' + ids.server
  const base = 'https://github.com/inchidev/llll/releases/download/v0.2.13/'
  const config = '{"architecture":"amd64","os":"linux"}', layer = 'verified immutable layer'
  const manifest = JSON.stringify({ schemaVersion: 2, config: { digest: 'sha256:' + sha(config) }, layers: [{ digest: 'sha256:' + sha(layer) }] })
  const files = Object.fromEntries([['llll-workspace-config.json', config], ['llll-workspace-layer-0.tar.gz', layer], ['llll-workspace-manifest.json', manifest]].map(([name, content]) => [name, { sha256: sha(content), size: Buffer.byteLength(content) }]))
  const factory = JSON.stringify({ schemaVersion: 1, version: '0.2.13', manifestDigest: 'sha256:' + sha(manifest), files,
    layers: [{ file: 'llll-workspace-layer-0.tar.gz', digest: 'sha256:' + sha(layer), size: Buffer.byteLength(layer) }] })
  const assets: Record<string, string> = { 'llll-factory.json': factory, 'llll-workspace-config.json': config, 'llll-workspace-layer-0.tar.gz': layer, 'llll-workspace-manifest.json': manifest }
  const expectedImage = `registry.cloudflare.com/${accountId}/${workerName}-factory@sha256:${sha(manifest)}`
  const state = { tamper: '', redirectUpload: false, uploaded: false, expandedSize: false, observability: undefined as undefined | { enabled: boolean }, application: null as null | Record<string, unknown>, existingImage: '', repairSupported: true, paidUnavailable: false, artifactsDenied: false, artifactsMissing: false }
  const calls: Array<{ path: string; init?: RequestInit }> = [], requests: Array<{ url: string; init?: RequestInit }> = []
  const api = vi.fn(async (_token: string, path: string, init?: RequestInit) => {
    calls.push({ path, init })
    if (path.endsWith('/containers/me')) { if (state.paidUnavailable) throw new Error('Workers Paid or Containers access required'); return {} }
    if (path.includes('/artifacts/namespaces')) {
      if (state.artifactsDenied) throw Object.assign(new Error('forbidden'), { statusCode: 403 })
      if (init?.method === 'POST') return { namespace: workerName + '-factory' }
      if (state.artifactsMissing) { state.artifactsMissing = false; throw Object.assign(new Error('missing'), { statusCode: 404 }) }
      return { name: workerName + '-factory' }
    }
    if (path.endsWith('/registries/registry.cloudflare.com/credentials')) return { username: 'v1', password: 'registry-secret' }
    if (path.includes('/d1/database/')) {
      const body = JSON.parse(String(init?.body))
      return [{ success: true, results: f.db.prepare(body.sql).all(...(body.params || [])) }]
    }
    if (path.endsWith('/containers/applications/existing/rollouts') && init?.method === 'POST') {
      const body = JSON.parse(String(init.body))
      expect(body).toMatchObject({ strategy: 'rolling', kind: 'full_auto', step_percentage: 100 })
      fixtureApplication().configuration = state.expandedSize
        ? { image: body.target_configuration.image, vcpu: 0.5, memory_mib: 4096, disk: { size_mb: 8000 } }
        : body.target_configuration
      return state.application
    }
    if (path.endsWith('/containers/applications/existing')) return state.application
    if (path.includes('/workers/scripts/')) { state.uploaded = true; return {} }
    if (path.endsWith('/containers/applications')) return init?.method === 'POST' ? { id: 'application-id' } : state.application ? [state.application] : []
    throw new Error('Unexpected control-plane path ' + path)
  })
  const settings = vi.fn(async () => ({
    observability: state.observability,
    placement: { region: 'aws:ap-northeast-3' },
    bindings: [
      { type: 'd1', name: 'DB', database_id: 'existing-database' }, { type: 'secret_text', name: 'AUTH_SECRET' },
      { type: 'kv_namespace', name: 'TICKETS', namespace_id: 'existing-kv' }, { type: 'secret_text', name: 'GITHUB_AGENT_APP_PRIVATE_KEY' },
      ...(state.existingImage ? [{ type: 'plain_text', name: 'FACTORY_IMAGE', text: state.existingImage }] : []),
      ...(state.uploaded || state.existingImage ? [{ type: 'durable_object_namespace', name: 'FACTORY_COMPUTE', namespace_id: 'factory-namespace' }] : []),
    ], tags: ['llll-server'], annotations: { 'workers/tag': 'llll-0.2.13' }, containers: [{ class_name: 'AgentComputeDurableObject' }],
  }))
  vi.resetModules()
  vi.doMock('../../packages/deployment-core/src/cloudflare-client', () => ({ cloudflareApi: api, cloudflareClient: () => ({ workers: { scripts: { scriptAndVersionSettings: { get: settings } } } }) }))
  vi.doMock('../../packages/deployment-core/src/servers', () => ({ readL4Server: vi.fn(async () => ({ version: '0.2.13', origin: 'https://customer.example' })) }))
  vi.doMock('../../packages/deployment-core/src/release', () => ({ releaseManifestUrl: () => base + 'llll-cloudflare-manifest.json', loadL4Release: async () => ({ manifest: { version: '0.2.13', capabilities: state.repairSupported ? ['factory-unused-repair-v1'] : [], compatibilityDate: '2026-10-26', compatibilityFlags: ['nodejs_compat'], factory: { url: base + 'llll-factory.json', sha256: sha(factory), size: Buffer.byteLength(factory) } }, worker: new TextEncoder().encode('published immutable module').buffer }) }))
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input); requests.push({ url, init })
    if (url.startsWith(base)) {
      const name = url.slice(base.length), body = assets[name]
      if (body === undefined) throw new Error('Unexpected release asset ' + name)
      return new Response(name === state.tamper ? body.replace(/./u, 'X') : body)
    }
    if (url.startsWith('https://registry.cloudflare.com/')) {
      if (init?.body instanceof ReadableStream) await new Response(init.body).arrayBuffer()
      if (init?.method === 'POST') return new Response(null, { status: 202, headers: { Location: state.redirectUpload ? 'https://attacker.example/upload' : `/v2/${accountId}/${workerName}-factory/blobs/uploads/upload-${requests.length}` } })
      if (init?.method === 'PATCH') return new Response(null, { status: 202, headers: { Location: url } })
      return new Response(null, { status: 201 })
    }
    throw new Error('Unexpected remote destination ' + url)
  }))
  const module = await import('../../packages/deployment-core/src/factory')
  function fixtureApplication() { if (!state.application) throw new Error('Missing fixture application'); return state.application }
  return { enable: (consent = true) => module.enableL4Factory('browser-cloudflare-grant', accountId, workerName, consent), state, calls, requests, expectedImage }
}

it.each([undefined, { enabled: false }])('preserves Factory provisioning observability settings: %j', async observability => {
  const fixture = await provisioningFixture()
  fixture.state.observability = observability
  await fixture.enable()
  const uploaded = fixture.calls.find(call => call.path.includes('/workers/scripts/'))!
  const metadata = JSON.parse(String((uploaded.init!.body as FormData).get('metadata')))
  expect(metadata.observability).toMatchObject(observability ?? { enabled: true, redact_query_string: true })
  expect(metadata.placement).toEqual({ region: 'aws:ap-northeast-3' })
})

it('repairs an old image only when Factory has never admitted a Node or Task source', async () => {
  const fixture = await provisioningFixture()
  f.db.exec('DELETE FROM factory_approvals; DELETE FROM factory_boxes; DELETE FROM compute_nodes')
  fixture.state.existingImage = 'registry.cloudflare.com/account/old@sha256:' + 'f'.repeat(64)
  fixture.state.application = { id: 'existing', name: 'llll-' + ids.server + '-factory', durable_objects: { namespace_id: 'factory-namespace' }, configuration: { image: fixture.state.existingImage, instance_type: 'standard-1' }, scheduling_policy: 'default' }
  await expect(fixture.enable()).resolves.toMatchObject({ image: fixture.expectedImage })
  expect(fixture.state.application.configuration).toMatchObject({ image: fixture.expectedImage })
  expect(f.db.prepare("SELECT value FROM server_settings WHERE key='factory.provisioning'").get()).toBeUndefined()
})

it('completes an image rollout when the provider expands the reviewed instance size', async () => {
  const fixture = await provisioningFixture()
  f.db.exec('DELETE FROM factory_approvals; DELETE FROM factory_boxes; DELETE FROM compute_nodes')
  fixture.state.expandedSize = true
  fixture.state.existingImage = 'old-image'
  fixture.state.application = { id: 'existing', name: 'llll-' + ids.server + '-factory', durable_objects: { namespace_id: 'factory-namespace' }, configuration: { image: 'old-image', vcpu: 0.5, memory_mib: 4096, disk: { size_mb: 8000 } }, scheduling_policy: 'default' }
  await expect(fixture.enable()).resolves.toMatchObject({ image: fixture.expectedImage })
  expect(f.db.prepare("SELECT value FROM server_settings WHERE key='factory.provisioning'").get()).toBeUndefined()
})

it('does not acquire repair authority for an unchanged expanded provider configuration', async () => {
  const fixture = await provisioningFixture()
  fixture.state.existingImage = fixture.expectedImage
  fixture.state.application = { id: 'existing', name: 'llll-' + ids.server + '-factory', durable_objects: { namespace_id: 'factory-namespace' }, configuration: { image: fixture.expectedImage, vcpu: 0.5, memory_mib: 4096, disk: { size_mb: 8000 } }, scheduling_policy: 'default' }
  // Existing Node and source authority deliberately remain: only an actual change needs repair.
  await expect(fixture.enable()).resolves.toMatchObject({ image: fixture.expectedImage })
  expect(fixture.calls.some(call => call.path.endsWith('/rollouts'))).toBe(false)
})

it.each(['node', 'source'])('preserves the pinned image when existing Factory %s authority remains', async kind => {
  const fixture = await provisioningFixture()
  fixture.state.existingImage = 'registry.cloudflare.com/account/old@sha256:' + 'f'.repeat(64)
  if (kind === 'node') f.db.exec('DELETE FROM factory_approvals; DELETE FROM factory_boxes')
  if (kind === 'source') {
    // A Task's box, with its source, still counts as authority.
    f.db.prepare('INSERT INTO factory_boxes(id,channel_id,task_id,agent_id,initiated_by,node_id,environment_json,origin_run_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(crypto.randomUUID(), run.channelId, run.taskId, run.agentId, run.initiatedBy, nodeId, run.environmentJson, run.id, new Date().toISOString(), new Date().toISOString())
    f.db.exec("UPDATE compute_nodes SET capabilities_json=json_remove(capabilities_json,'$.provider')")
  }
  await expect(fixture.enable()).rejects.toMatchObject({ statusCode: 409 })
  expect(fixture.state.uploaded).toBe(false)
  expect(fixture.calls.some(call => call.path.endsWith('/registries/registry.cloudflare.com/credentials'))).toBe(false)
})

function unusedFactory() { f.db.exec('DELETE FROM factory_approvals; DELETE FROM factory_boxes; DELETE FROM compute_nodes') }
const repairQuery = async (sql: string, params: (string | number)[]) => f.db.prepare(sql).all(...params) as { value: string }[]

it('serializes unused repair and fences a superseded installer', async () => {
  unusedFactory()
  const first = await beginUnusedFactoryRepair(repairQuery)
  await expect(beginUnusedFactoryRepair(repairQuery)).rejects.toMatchObject({ statusCode: 409 })
  f.db.prepare("UPDATE server_settings SET value=json_set(value,'$.expiresAt',0) WHERE key='factory.provisioning'").run()
  const next = await beginUnusedFactoryRepair(repairQuery)
  await expect(first.check()).rejects.toMatchObject({ statusCode: 409 })
  await expect(first.complete()).rejects.toMatchObject({ statusCode: 409 })
  await next.complete()
})

it('keeps failed provisioning closed to activation and allows a verified retry', async () => {
  const fixture = await provisioningFixture()
  unusedFactory(); fixture.state.existingImage = 'registry.cloudflare.com/account/old@sha256:' + 'f'.repeat(64)
  fixture.state.tamper = 'llll-workspace-layer-0.tar.gz'
  await expect(fixture.enable()).rejects.toThrow('Image layer checksum mismatch')
  expect(JSON.parse(String(f.db.prepare("SELECT value FROM server_settings WHERE key='factory.provisioning'").get()!.value)).failed).toBe(1)
  fixture.state.tamper = ''
  await fixture.enable()
  expect(f.db.prepare("SELECT value FROM server_settings WHERE key='factory.provisioning'").get()).toBeUndefined()
})

it('finishes a failed repair even when bindings and application already have the new image', async () => {
  const fixture = await provisioningFixture()
  unusedFactory(); fixture.state.existingImage = fixture.expectedImage
  fixture.state.application = { id: 'existing', name: 'llll-' + ids.server + '-factory', durable_objects: { namespace_id: 'factory-namespace' }, configuration: { image: fixture.expectedImage, instance_type: 'standard-1' }, scheduling_policy: 'default' }
  await (await beginUnusedFactoryRepair(repairQuery)).failed()
  await fixture.enable()
  expect(f.db.prepare("SELECT value FROM server_settings WHERE key='factory.provisioning'").get()).toBeUndefined()
})

it('requires the installed immutable Server artifact to advertise repair activation fencing', async () => {
  const fixture = await provisioningFixture()
  unusedFactory(); fixture.state.existingImage = 'old-image'; fixture.state.repairSupported = false
  await expect(fixture.enable()).rejects.toThrow('Update this Server')
  expect(fixture.state.uploaded).toBe(false)
  expect(f.db.prepare("SELECT value FROM server_settings WHERE key='factory.provisioning'").get()).toBeUndefined()
})

it.each(['before probe', 'during probe'])('blocks activation racing unused repair: %s', async phase => {
  unusedFactory()
  const probe = vi.fn(async () => {
    if (phase === 'during probe') await beginUnusedFactoryRepair(repairQuery)
    return Response.json({ ok: true })
  })
  f.env.FACTORY_IMAGE = image
  f.env.FACTORY_COMPUTE = { getByName: () => ({ fetch: probe }) } as never
  f.env.FACTORY_CODE = { create: async () => ({ token: 'probe-token' }), get: async () => ({ revokeToken: async () => {}, [Symbol.dispose]() {} }), delete: async () => {} } as never
  if (phase === 'before probe') await beginUnusedFactoryRepair(repairQuery)
  await expect(configureCloudflareFactory(f.env, await f.actor(), true)).rejects.toMatchObject({ statusCode: 409 })
  expect(f.db.prepare('SELECT count(*) AS n FROM compute_nodes').get()!.n).toBe(0)
  if (phase === 'before probe') expect(probe).not.toHaveBeenCalled()
})

it('paid provisioning requires explicit consent and stops before writes when provider access is unavailable', async () => {
  const fixture = await provisioningFixture()
  await expect(fixture.enable(false)).rejects.toMatchObject({ statusCode: 400 })
  expect(fixture.calls).toEqual([]); expect(fixture.requests).toEqual([])
  fixture.state.paidUnavailable = true
  await expect(fixture.enable()).rejects.toThrow('Workers Paid or Containers access required')
  expect(fixture.calls.every(call => !call.init?.method || call.init.method === 'GET')).toBe(true)
  expect(fixture.requests).toEqual([])
})

it('refuses Factory provisioning when the Cloudflare grant is missing Artifacts scopes', async () => {
  const fixture = await provisioningFixture()
  fixture.state.artifactsDenied = true
  await expect(fixture.enable()).rejects.toThrow('Reconnect Cloudflare and approve Artifacts Read and Artifacts Write')
  expect(fixture.calls.some(call => call.path.includes('/workers/scripts/'))).toBe(false)
  expect(fixture.calls.some(call => call.init?.method === 'POST')).toBe(false)
  expect(fixture.requests).toEqual([])
})

it('creates the Artifacts namespace when the account does not have one yet', async () => {
  const fixture = await provisioningFixture()
  fixture.state.artifactsMissing = true
  await fixture.enable()
  expect(fixture.calls.some(call => call.path.endsWith('/artifacts/namespaces') && call.init?.method === 'POST')).toBe(true)
})

it('provisions only verified release blobs, preserves existing bindings and never stores the browser account credential', async () => {
  const fixture = await provisioningFixture()
  expect(await fixture.enable()).toMatchObject({ state: 'provisioning', image: fixture.expectedImage, origin: 'https://customer.example' })
  const uploaded = fixture.calls.find(call => call.path.includes('/workers/scripts/'))!
  const form = uploaded.init!.body as FormData
  const metadata = JSON.parse(String(form.get('metadata')))
  expect(metadata.keep_assets).toBe(true)
  for (const name of ['DB', 'AUTH_SECRET', 'TICKETS', 'GITHUB_AGENT_APP_PRIVATE_KEY']) expect(metadata.bindings).toContainEqual({ type: 'inherit', name })
  expect(metadata.bindings).toContainEqual(expect.objectContaining({ type: 'artifacts', name: 'FACTORY_CODE' }))
  expect(metadata.bindings).not.toContainEqual(expect.objectContaining({ type: 'r2_bucket' }))
  expect(metadata.containers).toContainEqual({ class_name: 'AgentComputeDurableObject' })
  expect(metadata.containers).toContainEqual(expect.objectContaining({ class_name: 'FactoryComputeDurableObject', image: fixture.expectedImage, instance_type: 'standard-1', max_instances: 4, name: 'llll-' + ids.server + '-factory' }))
  // One container is one box: the application runs at most the policy's boxes.
  const application = fixture.calls.find(call => call.path.endsWith('/containers/applications') && call.init?.method === 'POST')!
  expect(JSON.parse(String(application.init!.body))).toMatchObject({ max_instances: 4, configuration: { image: fixture.expectedImage, instance_type: 'standard-1' } })
  expect(await (form.get('llll-worker.mjs') as Blob).text()).toBe('published immutable module')
  expect(JSON.stringify(metadata)).not.toContain('browser-cloudflare-grant')
  expect(JSON.stringify(metadata)).not.toContain('registry-secret')
  const registry = fixture.requests.filter(request => request.url.startsWith('https://registry.cloudflare.com/'))
  expect(registry.length).toBeGreaterThan(0)
  expect(registry.every(request => new Headers(request.init?.headers).get('Authorization') === 'Basic ' + btoa('v1:registry-secret'))).toBe(true)
  expect(fixture.calls.some(call => /subscriptions|r2|upgrade/iu.test(call.path))).toBe(false)
})

it('does not commit a corrupt layer or change the Server when a release blob checksum fails', async () => {
  const fixture = await provisioningFixture(); fixture.state.tamper = 'llll-workspace-layer-0.tar.gz'
  await expect(fixture.enable()).rejects.toThrow('Image layer checksum mismatch')
  expect(fixture.calls.some(call => call.path.includes('/workers/scripts/'))).toBe(false)
  expect(fixture.requests.some(request => request.url.includes('/manifests/'))).toBe(false)
})

it('refuses an image registry upload redirect before it can disclose registry credentials', async () => {
  const fixture = await provisioningFixture(); fixture.state.redirectUpload = true
  await expect(fixture.enable()).rejects.toThrow('Unexpected image registry upload destination')
  expect(fixture.requests.some(request => new URL(request.url).origin === 'https://attacker.example')).toBe(false)
  expect(fixture.calls.some(call => call.path.includes('/workers/scripts/'))).toBe(false)
})

it('refuses an existing application whose image differs from the approved release and limits', async () => {
  const fixture = await provisioningFixture()
  fixture.state.application = { id: 'existing', name: 'llll-' + ids.server + '-factory', durable_objects: { namespace_id: 'factory-namespace' },
    configuration: { image: 'registry.cloudflare.com/account/unreviewed@sha256:' + 'f'.repeat(64), instance_type: 'standard-4' }, scheduling_policy: 'default' }
  await expect(fixture.enable()).rejects.toThrow(/image|policy|limit|configuration/iu)
})
