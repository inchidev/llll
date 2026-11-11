import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mcpFixture, ids } from '../helpers/outbound-mcp'
import { ALL_PERMISSIONS } from '../../shared/permissions'
import { decryptSecret } from '../../shared/encrypted-secret'
import { factoryHash } from '../../server/utils/factory-authority'
import { computePoll } from '../../server/utils/compute-nodes'
import { boxCompletion, ensureBox } from '../../server/utils/factory-boxes'
import { compileEgress, replacePlaceholders, type EgressInput } from '../../server/utils/box-egress'
import { PERSON_WAIT_MS, decideApproval, expireApprovals, outwardToolCall, unansweredRequest } from '../../server/utils/factory-approvals'
import { factoryStatus } from '../../server/utils/factory-status'
import { createProjectSecret, deleteProjectSecret, getProjectNetwork, listProjectSecrets, saveProjectNetwork, updateProjectSecret } from '../../server/utils/project-egress'
import { findAgentRun } from '../../server/utils/agent-run-service'
import type { AgentRun } from '../../shared/agent-execution'

const now = '2026-11-07T12:00:00.000Z', later = '2026-11-07T13:00:00.000Z', earlier = '2026-11-07T11:00:00.000Z'
const telegram = { id: 's1', name: 'TELEGRAM_TOKEN', placeholder: 'L4_SECRET_TELEGRAM_TOKEN', hosts: ['api.telegram.org'], updatedAt: now }
const deploy = { id: 's2', name: 'DEPLOY_KEY', placeholder: 'L4_SECRET_DEPLOY_KEY', hosts: ['api.cloudflare.com'], updatedAt: now }
const base = (extra: Partial<EgressInput> = {}): EgressInput => ({ serverHosts: ['server.example'], network: { presets: ['npm'], hosts: ['api.cloudflare.com'] },
  secrets: [telegram, deploy], windows: [], plan: null, mode: 'role', now, ...extra })

describe('the hosts and secrets in effect for a box', () => {
  it('opens this Server, the presets, the Project hosts and the windows still open', async () => {
    const compiled = await compileEgress(base({ windows: [{ host: 'api.telegram.org', secrets: [], expiresAt: later }, { host: 'expired.example.com', secrets: [], expiresAt: earlier }] }))
    expect(compiled.hosts).toEqual(['api.cloudflare.com', 'api.telegram.org', 'registry.npmjs.org', 'server.example'])
    expect(compiled.listed).toEqual(['api.cloudflare.com', 'registry.npmjs.org', 'server.example'])
    // TLS is terminated only where a secret is bound.
    expect(compiled.secretHosts).toEqual(['api.cloudflare.com', 'api.telegram.org'])
    const closed = await compileEgress(base({ windows: [{ host: 'api.telegram.org', secrets: [], expiresAt: earlier }] }))
    expect(closed.hosts).not.toContain('api.telegram.org')
    expect(closed.revision).not.toBe(compiled.revision)
  })

  it('puts in every bound secret in role mode, only on its open bound hosts', async () => {
    expect((await compileEgress(base())).secrets).toEqual([{ id: 's2', placeholder: 'L4_SECRET_DEPLOY_KEY', hosts: ['api.cloudflare.com'] }])
    expect((await compileEgress(base({ windows: [{ host: 'api.telegram.org', secrets: [], expiresAt: later }] }))).secrets.map(secret => secret.id)).toEqual(['s2', 's1'])
  })

  it('in plan mode puts in only what the approved plan names, and in review mode only what an open window names', async () => {
    const window = { host: 'api.telegram.org', secrets: ['TELEGRAM_TOKEN'], expiresAt: later }
    expect((await compileEgress(base({ mode: 'plan' }))).secrets).toEqual([])
    expect((await compileEgress(base({ mode: 'plan', plan: { hosts: [], secrets: ['DEPLOY_KEY'] } }))).secrets.map(secret => secret.id)).toEqual(['s2'])
    expect((await compileEgress(base({ mode: 'review' }))).secrets).toEqual([])
    expect((await compileEgress(base({ mode: 'review', windows: [window] }))).secrets).toEqual([{ id: 's1', placeholder: 'L4_SECRET_TELEGRAM_TOKEN', hosts: ['api.telegram.org'] }])
    expect((await compileEgress(base({ mode: 'review', windows: [{ ...window, expiresAt: earlier }] }))).secrets).toEqual([])
    // Every Project placeholder stays known, so one sent where it is not in effect is refused instead of leaking out.
    expect((await compileEgress(base({ mode: 'review' }))).known.map(secret => secret.placeholder)).toEqual(['L4_SECRET_DEPLOY_KEY', 'L4_SECRET_TELEGRAM_TOKEN'])
  })

  it('changes its revision when a value is replaced', async () => {
    const before = await compileEgress(base()), after = await compileEgress(base({ secrets: [telegram, { ...deploy, updatedAt: later }] }))
    expect(after.revision).not.toBe(before.revision)
  })

  it('replaces only placeholders in effect at the host and refuses a known one that is not', () => {
    const values = [{ placeholder: 'L4_SECRET_TELEGRAM_TOKEN', hosts: ['api.telegram.org'], value: '1:a b/c' }]
    const known = [{ placeholder: 'L4_SECRET_TELEGRAM_TOKEN', name: 'TELEGRAM_TOKEN', hosts: ['api.telegram.org'] }, { placeholder: 'L4_SECRET_DEPLOY_KEY', name: 'DEPLOY_KEY', hosts: ['api.cloudflare.com'] }]
    expect(replacePlaceholders('/botL4_SECRET_TELEGRAM_TOKEN/getMe', 'api.telegram.org', values, known, 'url')).toEqual({ text: '/bot1:a%20b%2Fc/getMe', changed: true })
    expect(replacePlaceholders('Bearer L4_SECRET_TELEGRAM_TOKEN L4_SECRET_OTHER', 'api.telegram.org', values, known)).toEqual({ text: 'Bearer 1:a b/c L4_SECRET_OTHER', changed: true })
    expect(replacePlaceholders('token=L4_SECRET_TELEGRAM_TOKEN', 'attacker.example.com', values, known)).toMatchObject({ refused: expect.stringContaining('not bound to attacker.example.com') })
    expect(replacePlaceholders('L4_SECRET_DEPLOY_KEY', 'api.cloudflare.com', values, known)).toMatchObject({ refused: expect.stringContaining('request_network_window {"host":"api.cloudflare.com","secrets":["DEPLOY_KEY"]}') })
  })
})

const nodeId = '00000000-0000-4000-8000-000000000099'
const image = 'registry.example/l4@sha256:' + 'a'.repeat(64)
const capabilities = { diskBytes: 1073741824, docker: true, durableDisk: true, isolation: 'shared-kernel', image, capacity: { cpu: 4, memoryMiB: 16384, boxes: 4 }, protocol: 2 }
const config = { name: 'Bot', computeNodeId: nodeId, sourceRepo: 'inchidev/bot', sourceRepoId: 11, sourceInstallationId: 101, workRepo: 'inchidev/bot', workRepoId: 11, workInstallationId: 101, baseBranch: 'main', requiredChecks: [], previewHosts: [] }
let f: ReturnType<typeof mcpFixture>, run: AgentRun, boxId: string
function mode(value: 'role' | 'plan' | 'review') {
  const mandate = JSON.parse(run.mandateJson)
  mandate.execution = { ...mandate.execution, mode: value }
  f.db.prepare('UPDATE agent_runs SET mandate_json=? WHERE id=?').run(JSON.stringify(mandate), run.id)
  run = { ...run, mandateJson: JSON.stringify(mandate) }
}
const owner = () => f.actor(ids.owner)
const sync = async (lease?: string) => (await computePoll(f.env, nodeId, { operation: 'sync', capacity: { cpu: 4, memoryMiB: 16384, boxes: 4, diskFree: 1e10 },
  boxes: lease ? [{ id: boxId, lease, state: 'running', runId: run.id, runtimeMs: 0 }] : [] }) as { boxes: Array<{ id: string; lease: string; egress: { revision: string; hosts: string[]; secretHosts: string[] } }> }).boxes.find(box => box.id === boxId)!
const windowCall = (callId: string, input: Record<string, unknown>) => outwardToolCall(f.env, run.id, 'request_network_window', callId, { minutes: 30, secrets: [], reason: 'Send the game to the bot', ...input })
const digest = (id: string) => (f.db.prepare('SELECT digest FROM factory_approvals WHERE id=?').get(id) as { digest: string }).digest

beforeEach(async () => {
  f = mcpFixture()
  f.env.PUBLIC_ORIGIN = 'https://server.example'
  f.db.prepare('UPDATE roles SET permissions_bitmask=? WHERE id=?').run(ALL_PERMISSIONS, ids.agentRole)
  f.db.prepare('INSERT INTO task_boards(id,name,created_by) VALUES(?,?,?)').run('bot-board', 'Factory', ids.owner)
  f.db.prepare("INSERT INTO tasks(id,board_id,title,assignee_id,created_by,status) VALUES(?,?,?,?,?,'ready')").run('bot-task', 'bot-board', 'Ship the bot', ids.agent, ids.owner)
  const created = await f.run(ids.owner, undefined, 'bot-task')
  f.db.prepare('INSERT INTO compute_nodes(id,name,token_hash,capabilities_json,last_seen,created_by,created_at) VALUES(?,?,?,?,?,?,?)').run(nodeId, 'Node', await factoryHash('node-token'), JSON.stringify(capabilities), now, ids.owner, now)
  f.db.prepare('INSERT INTO agent_environments(id,config_json,created_by,created_at,updated_at) VALUES(?,?,?,?,?)').run('env', JSON.stringify(config), ids.owner, now, now)
  f.db.prepare('INSERT INTO projects(id,name,created_by,created_at,updated_at) VALUES(?,?,?,?,?)').run('project', 'Bot', ids.owner, now, now)
  f.db.prepare("INSERT INTO project_repositories(id,project_id,provider,host,external_id,slug,default_branch,environment_id,created_by,created_at) VALUES('repo','project','github','https://github.com','11','inchidev/bot','main','env',?,?)").run(ids.owner, now)
  f.db.prepare('UPDATE tasks SET environment_id=? WHERE id=?').run('env', 'bot-task')
  f.db.prepare('UPDATE agent_runs SET environment_json=?,mandate_json=? WHERE id=?').run(JSON.stringify({ ...config, id: 'env', enabled: true, version: 1, baseSha: 'a'.repeat(40), baseTreeSha: 'b'.repeat(40) }),
    JSON.stringify({ ...JSON.parse(created.run.mandateJson), environmentId: 'env', environmentVersion: 1 }), created.run.id)
  run = (await findAgentRun(f.env, created.run.id))!
  boxId = await ensureBox(f.env, run, nodeId)
})
afterEach(() => f.db.close())

describe('Project secrets', () => {
  it('are write-only: the list shows names, placeholders and hosts, never a value, and the value round-trips only under its scope', async () => {
    const secret = await createProjectSecret(f.env, await owner(), 'project', { name: 'telegram_token', value: '123456:real-token', hosts: ['API.Telegram.org'] })
    expect(secret).toMatchObject({ name: 'TELEGRAM_TOKEN', placeholder: 'L4_SECRET_TELEGRAM_TOKEN', hosts: ['api.telegram.org'], lastUsedAt: null })
    const listed = await listProjectSecrets(f.env, await owner(), 'project')
    expect(listed.canManage).toBe(true)
    expect(JSON.stringify(listed)).not.toContain('123456:real-token')
    const row = f.db.prepare('SELECT secret_ciphertext AS ciphertext,secret_iv AS iv,secret_version AS version FROM project_secrets WHERE id=?').get(secret.id) as { ciphertext: string; iv: string; version: number }
    expect(row.ciphertext).not.toContain('real-token')
    expect(await decryptSecret(f.env.AUTH_SECRET!, `project-secret:${secret.id}`, row)).toBe('123456:real-token')
    await expect(decryptSecret(f.env.AUTH_SECRET!, 'project-secret:another', row)).rejects.toThrow()
    await expect(createProjectSecret(f.env, await owner(), 'project', { name: 'TELEGRAM_TOKEN', value: 'x', hosts: ['api.telegram.org'] })).rejects.toMatchObject({ statusCode: 409 })
    // A replaced value keeps its placeholder; the old value is gone.
    const replaced = await updateProjectSecret(f.env, await owner(), 'project', secret.id, { value: 'new-token' })
    expect(replaced.placeholder).toBe('L4_SECRET_TELEGRAM_TOKEN')
    const next = f.db.prepare('SELECT secret_ciphertext AS ciphertext,secret_iv AS iv,secret_version AS version FROM project_secrets WHERE id=?').get(secret.id) as typeof row
    expect(await decryptSecret(f.env.AUTH_SECRET!, `project-secret:${secret.id}`, next)).toBe('new-token')
    await deleteProjectSecret(f.env, await owner(), 'project', secret.id)
    expect((await listProjectSecrets(f.env, await owner(), 'project')).secrets).toEqual([])
  })

  it('are managed only by whoever may manage the Project, in a person’s session', async () => {
    const member = await f.actor(ids.member)
    await expect(createProjectSecret(f.env, member, 'project', { name: 'A', value: 'v', hosts: ['api.example.com'] })).rejects.toMatchObject({ statusCode: 403 })
    await expect(saveProjectNetwork(f.env, member, 'project', { presets: ['npm'], hosts: [] })).rejects.toMatchObject({ statusCode: 403 })
    await expect(createProjectSecret(f.env, (await f.run()).authorization, 'project', { name: 'A', value: 'v', hosts: ['api.example.com'] })).rejects.toMatchObject({ statusCode: 403 })
    for (const hosts of [['10.0.0.1'], ['*.example.com'], ['localhost'], ['printer.local'], ['https://api.example.com/x']]) {
      await expect(createProjectSecret(f.env, await owner(), 'project', { name: 'A', value: 'v', hosts })).rejects.toThrow()
    }
    await expect(createProjectSecret(f.env, await owner(), 'project', { name: 'A', value: 'line\nbreak', hosts: ['api.example.com'] })).rejects.toThrow()
  })
})

describe('network windows', () => {
  it('a sync names the Project’s hosts; the secrets operation gives the Node only the values in effect', async () => {
    mode('role')
    await saveProjectNetwork(f.env, await owner(), 'project', { presets: ['npm'], hosts: ['api.telegram.org'] })
    expect(await getProjectNetwork(f.env, await owner(), 'project')).toMatchObject({ network: { presets: ['npm'], hosts: ['api.telegram.org'] }, canManage: true })
    await createProjectSecret(f.env, await owner(), 'project', { name: 'TELEGRAM_TOKEN', value: 'real-token', hosts: ['api.telegram.org'] })
    await createProjectSecret(f.env, await owner(), 'project', { name: 'OTHER', value: 'other-value', hosts: ['api.other.com'] })
    const { lease, egress } = await sync()
    expect(egress.hosts).toEqual(['api.telegram.org', 'registry.npmjs.org', 'server.example'])
    expect(egress.secretHosts).toEqual(['api.telegram.org'])
    expect(JSON.stringify(egress)).not.toContain('real-token')
    const secrets = await computePoll(f.env, nodeId, { operation: 'secrets', boxId, lease }) as { revision: string; secrets: Array<{ placeholder: string; value: string }>; known: unknown[] }
    expect(secrets.revision).toBe(egress.revision)
    expect(secrets.secrets).toEqual([{ placeholder: 'L4_SECRET_TELEGRAM_TOKEN', hosts: ['api.telegram.org'], value: 'real-token' }])
    expect(secrets.known).toHaveLength(2)
    await expect(computePoll(f.env, nodeId, { operation: 'secrets', boxId, lease: 'f'.repeat(64) })).rejects.toMatchObject({ statusCode: 403 })
    expect(await factoryStatus(f.env, run.id)).toMatchObject({ network: { open: egress.hosts, secrets: expect.arrayContaining([{ placeholder: 'L4_SECRET_TELEGRAM_TOKEN', boundTo: ['api.telegram.org'], putInAt: ['api.telegram.org'] }]) } })
  })

  it('in review mode a person opens a window for its time, with its secret, and the Run may end while it stays open', async () => {
    mode('review')
    await createProjectSecret(f.env, await owner(), 'project', { name: 'TELEGRAM_TOKEN', value: 'real-token', hosts: ['api.telegram.org'] })
    const { lease } = await sync()
    await expect(windowCall('w0', { host: 'api.telegram.org', secrets: ['MISSING'] })).rejects.toMatchObject({ statusCode: 400 })
    const asked = await windowCall('w1', { host: 'api.telegram.org', secrets: ['TELEGRAM_TOKEN'] }) as { approvalId: string }
    expect(asked).toMatchObject({ outwardPending: true, status: 'pending' })
    expect((await sync(lease)).egress.hosts).not.toContain('api.telegram.org')
    expect((await boxCompletion(f.env, run)).pending).toBe(true)
    const before = Date.now()
    expect(await decideApproval(f.env, run.id, ids.owner, { id: asked.approvalId, digest: digest(asked.approvalId), decision: 'approve' })).toMatchObject({ status: 'approved', kind: 'window' })
    const expiresAt = (f.db.prepare('SELECT expires_at AS e FROM factory_approvals WHERE id=?').get(asked.approvalId) as { e: string }).e
    expect(Date.parse(expiresAt) - before).toBeGreaterThanOrEqual(30 * 60000 - 1000)
    expect(await windowCall('w1', { host: 'api.telegram.org', secrets: ['TELEGRAM_TOKEN'] })).toMatchObject({ open: true, host: 'api.telegram.org', secrets: ['L4_SECRET_TELEGRAM_TOKEN'] })
    expect((await sync(lease)).egress).toMatchObject({ hosts: expect.arrayContaining(['api.telegram.org']), secretHosts: ['api.telegram.org'] })
    expect((await computePoll(f.env, nodeId, { operation: 'secrets', boxId, lease }) as { secrets: unknown[] }).secrets).toHaveLength(1)
    // An open window holds no turn, and outlives the Run that asked for it until its time runs out.
    expect((await boxCompletion(f.env, run)).pending).toBe(false)
    f.db.prepare("UPDATE agent_runs SET status='completed' WHERE id=?").run(run.id)
    await expireApprovals(f.env)
    expect(f.db.prepare('SELECT status FROM factory_approvals WHERE id=?').get(asked.approvalId)).toMatchObject({ status: 'approved' })
    f.db.prepare("UPDATE agent_runs SET status='running' WHERE id=?").run(run.id)
    f.db.prepare('UPDATE factory_approvals SET expires_at=? WHERE id=?').run(new Date(Date.now() - 60000).toISOString(), asked.approvalId)
    expect((await sync(lease)).egress.hosts).not.toContain('api.telegram.org')
    // A window nobody answers holds the paid box's turn for half an hour at most, then closes unanswered.
    const ignored = await windowCall('w3', { host: 'api.telegram.org' }) as { approvalId: string }
    expect((await boxCompletion(f.env, run)).pending).toBe(true)
    f.db.prepare('UPDATE factory_approvals SET created_at=? WHERE id=?').run(new Date(Date.now() - PERSON_WAIT_MS - 1000).toISOString(), ignored.approvalId)
    expect((await boxCompletion(f.env, run)).pending).toBe(false)
    await expireApprovals(f.env)
    expect(f.db.prepare('SELECT status FROM factory_approvals WHERE id=?').get(ignored.approvalId)).toMatchObject({ status: 'expired' })
    expect(await unansweredRequest(f.env, { id: run.id, deadline: new Date(Date.now() + 3_600_000).toISOString() })).toContain('about api.telegram.org')
    // A rejected window stays closed.
    const second = await windowCall('w2', { host: 'api.telegram.org' }) as { approvalId: string }
    await decideApproval(f.env, run.id, ids.owner, { id: second.approvalId, digest: digest(second.approvalId), decision: 'reject' })
    expect(await windowCall('w2', { host: 'api.telegram.org' })).toMatchObject({ outwardPending: false, status: 'rejected' })
  })

  it('in role mode opens the Project’s own hosts without a person, but never a host outside them', async () => {
    mode('role')
    await saveProjectNetwork(f.env, await owner(), 'project', { presets: [], hosts: ['api.telegram.org'] })
    await createProjectSecret(f.env, await owner(), 'project', { name: 'TELEGRAM_TOKEN', value: 'real-token', hosts: ['api.telegram.org'] })
    await sync()
    expect(await windowCall('listed', { host: 'api.telegram.org', secrets: ['TELEGRAM_TOKEN'] })).toMatchObject({ open: true })
    expect(await windowCall('outside', { host: 'api.attacker.com' })).toMatchObject({ outwardPending: true, status: 'pending' })
  })

  it('in plan mode a window for a host and secret the approved plan named opens without asking again', async () => {
    mode('plan')
    await createProjectSecret(f.env, await owner(), 'project', { name: 'TELEGRAM_TOKEN', value: 'real-token', hosts: ['api.telegram.org'] })
    await sync()
    expect(await windowCall('early', { host: 'api.telegram.org', secrets: ['TELEGRAM_TOKEN'] })).toMatchObject({ status: 'pending' })
    const plan = await outwardToolCall(f.env, run.id, 'factory_plan', 'plan', { summary: 'Deploy the bot', steps: ['Call setWebhook'], hosts: ['api.telegram.org'], secrets: ['TELEGRAM_TOKEN'] }) as { approvalId: string }
    await decideApproval(f.env, run.id, ids.owner, { id: plan.approvalId, digest: digest(plan.approvalId), decision: 'approve' })
    // An approved plan holds no turn either.
    expect((await boxCompletion(f.env, run)).pending).toBe(true)
    f.db.prepare("UPDATE factory_approvals SET status='expired' WHERE call_id='early'").run()
    expect((await boxCompletion(f.env, run)).pending).toBe(false)
    expect(await windowCall('planned', { host: 'api.telegram.org', secrets: ['TELEGRAM_TOKEN'] })).toMatchObject({ open: true })
    expect(await windowCall('unplanned', { host: 'api.attacker.com' })).toMatchObject({ status: 'pending' })
  })

  it('a box whose repository is in no Project reaches only this Server', async () => {
    f.db.prepare('DELETE FROM project_repositories').run()
    expect((await sync()).egress).toMatchObject({ hosts: ['server.example'], secretHosts: [] })
    await expect(windowCall('w', { host: 'api.telegram.org' })).rejects.toMatchObject({ statusCode: 409 })
  })
})
