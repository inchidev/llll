import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { generateKeyPairSync } from 'node:crypto'
import { mcpFixture, ids } from '../helpers/outbound-mcp'
import { ALL_PERMISSIONS } from '../../shared/permissions'
import { factoryHash } from '../../server/utils/factory-authority'
import { computePoll, pairComputeNode, prepareComputePairing } from '../../server/utils/compute-nodes'
import { ensureBox } from '../../server/utils/factory-boxes'
import { approvalReview, decideApproval, listBoxReview, outwardToolCall, submitReview } from '../../server/utils/factory-approvals'
import { factoryFeedback } from '../../server/utils/factory-github'
import { factoryStatus } from '../../server/utils/factory-status'
import { githubPushGrant } from '../../server/utils/github-agent-client'
import { findAgentRun, runAuthorization, runCapability } from '../../server/utils/agent-run-service'
import { executeRunTool, toolsForRun } from '../../server/utils/agent-tools'
import { agentGateway } from '../../server/utils/agent-gateway'
import type { AgentRun } from '../../shared/agent-execution'

const nodeId = '00000000-0000-4000-8000-000000000099', otherNode = '00000000-0000-4000-8000-000000000098', image = 'registry.example/l4@sha256:' + 'a'.repeat(64)
const capabilities = { diskBytes: 1073741824 as const, docker: true as const, durableDisk: true as const, isolation: 'shared-kernel' as const, image, capacity: { cpu: 4, memoryMiB: 16384, boxes: 4 }, protocol: 2 as const }
const config = { name: 'Afterprompt', computeNodeId: nodeId, sourceRepo: 'inchidev/afterprompt', sourceRepoId: 11, sourceInstallationId: 101,
  workRepo: 'inchidev/afterprompt', workRepoId: 11, workInstallationId: 101, baseBranch: 'main', requiredChecks: ['test'], previewHosts: ['vercel.app'] }
const baseSha = 'a'.repeat(40), sha = 'c'.repeat(40), repair = 'e'.repeat(40)
let f: ReturnType<typeof mcpFixture>, run: AgentRun, boxId: string
const stored = new Map<string, string>()

/** GitHub as the publisher sees it: issued tokens, the box's branch, its pull request and checks. */
function githubFixture() {
  const state = { head: null as string | null, pull: null as number | null, tokens: [] as Array<{ permissions: unknown; repositories: unknown }>, revoked: [] as string[], writes: [] as Array<{ path: string; method: string; body: Record<string, unknown> }> }
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL, options: RequestInit = {}) => {
    const parsed = new URL(String(url)), path = parsed.pathname, method = options.method ?? 'GET', body = options.body ? JSON.parse(String(options.body)) : {}
    expect(parsed.origin).toBe('https://api.github.com')
    if (path.endsWith('/access_tokens')) { state.tokens.push({ permissions: body.permissions, repositories: body.repository_ids }); return Response.json({ token: `token-${state.tokens.length}-${body.permissions.contents}` }) }
    if (path === '/installation/token' && method === 'DELETE') { state.revoked.push(new Headers(options.headers).get('Authorization')!); return new Response(null, { status: 204 }) }
    if (method !== 'GET') state.writes.push({ path, method, body })
    if (path === `/repos/inchidev/afterprompt/git/ref/heads/l4-agent/${boxId}`) return state.head ? Response.json({ object: { sha: state.head } }) : Response.json({ message: 'Not Found' }, { status: 404 })
    const pull = () => ({ number: 77, state: 'open', draft: true, merged: false, mergeable_state: 'draft', html_url: '', head: { sha: state.head, ref: `l4-agent/${boxId}`, repo: { id: 11 } }, base: { ref: 'main', repo: { id: 11 } } })
    if (path.endsWith('/pulls') && method === 'GET') return Response.json(state.pull ? [pull()] : [])
    if (path.endsWith('/pulls') && method === 'POST') { expect(body).toMatchObject({ draft: true, head: `l4-agent/${boxId}`, base: 'main' }); state.pull = 77; return Response.json(pull()) }
    if (path.endsWith('/pulls/77')) return Response.json(pull())
    if (path.endsWith('/check-runs')) return Response.json({ total_count: 1, check_runs: [{ name: 'test', head_sha: state.head, status: 'completed', conclusion: 'success', details_url: null }] })
    if (path.endsWith('/statuses')) return Response.json([])
    if (path.endsWith('/deployments')) return Response.json([])
    if (path.endsWith('/actions/runs')) return Response.json({ total_count: 0, workflow_runs: [] })
    throw new Error('Unexpected GitHub fixture endpoint ' + method + ' ' + path)
  }))
  return state
}
function mode(value: 'role' | 'plan' | 'review') {
  const mandate = JSON.parse(run.mandateJson)
  mandate.execution = { ...mandate.execution, mode: value }
  f.db.prepare('UPDATE agent_runs SET mandate_json=? WHERE id=?').run(JSON.stringify(mandate), run.id)
  run = { ...run, mandateJson: JSON.stringify(mandate) }
}
const sync = async (node = nodeId, lease?: string) => (await computePoll(f.env, node, { operation: 'sync', capacity: { cpu: 4, memoryMiB: 16384, boxes: 4, diskFree: 1e10 },
  boxes: lease ? [{ id: boxId, lease, state: 'running', runId: run.id, runtimeMs: 0 }] : [] }) as { boxes: Array<{ id: string; lease: string; want: string; review?: { approvalId: string; sha: string; baseSha: string }; publish?: { approvalId: string; sha: string; ref: string; baseSha: string } }> }).boxes.find(box => box.id === boxId)
const publish = (callId: string, commit = sha) => executeRunTool(f.env, run.id, { callId, name: 'factory_publish', arguments: { sha: commit, title: 'Fix failing test', body: 'Tested with npm test' } }, () => {})
const approval = (id: string) => f.db.prepare('SELECT status,digest,diff_key AS diffKey,diff_digest AS diffDigest,result_json AS result FROM factory_approvals WHERE id=?').get(id) as { status: string; digest: string; diffKey: string | null; diffDigest: string | null; result: string | null }
const review = (commit = sha) => ({ ok: true, review: { sha: commit, baseSha, commits: [{ sha: commit, subject: 'Fix failing test' }], stat: ' answer.txt | 2 +-', patch: '-wrong\n+right', truncated: false } })
const encoded = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))

beforeEach(async () => {
  f = mcpFixture()
  stored.clear()
  f.env.FILES = { put: async (key: string, value: string) => { stored.set(key, value) }, get: async (key: string) => stored.has(key) ? { text: async () => stored.get(key)! } : null } as never
  f.db.prepare('INSERT INTO server_settings(key,value,updated_at) VALUES(?,?,?)').run('agents.executionPolicy', JSON.stringify({ mode: 'review' }), new Date().toISOString())
  f.db.prepare('UPDATE roles SET permissions_bitmask=? WHERE id=?').run(ALL_PERMISSIONS, ids.agentRole)
  f.db.prepare('INSERT INTO task_boards(id,name,created_by) VALUES(?,?,?)').run('factory-board', 'Factory', ids.owner)
  f.db.prepare("INSERT INTO tasks(id,board_id,title,assignee_id,created_by,status) VALUES(?,?,?,?,?,'ready')").run('factory-task', 'factory-board', 'Fix failing test', ids.agent, ids.owner)
  const created = await f.run(ids.owner, undefined, 'factory-task')
  for (const id of [nodeId, otherNode]) f.db.prepare('INSERT INTO compute_nodes(id,name,token_hash,capabilities_json,last_seen,created_by,created_at) VALUES(?,?,?,?,?,?,?)').run(id, 'Node', await factoryHash('node-token' + id), JSON.stringify(capabilities), new Date().toISOString(), ids.owner, new Date().toISOString())
  f.db.prepare('INSERT INTO agent_environments(id,config_json,created_by,created_at,updated_at) VALUES(?,?,?,?,?)').run('factory-env', JSON.stringify(config), ids.owner, new Date().toISOString(), new Date().toISOString())
  f.db.prepare('UPDATE tasks SET environment_id=? WHERE id=?').run('factory-env', 'factory-task')
  const mandate = { ...JSON.parse(created.run.mandateJson), environmentId: 'factory-env', environmentVersion: 1 }
  f.db.prepare('UPDATE agent_runs SET environment_json=?,mandate_json=? WHERE id=?').run(JSON.stringify({ ...config, id: 'factory-env', enabled: true, version: 1, baseSha, baseTreeSha: 'b'.repeat(40) }), JSON.stringify(mandate), created.run.id)
  run = (await findAgentRun(f.env, created.run.id))!
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 })
  f.env.GITHUB_AGENT_APP_ID = '4242'; f.env.GITHUB_AGENT_APP_PRIVATE_KEY = pair.privateKey.export({ type: 'pkcs1', format: 'pem' }).toString()
  boxId = await ensureBox(f.env, run, nodeId)
})
afterEach(() => { f.db.close(); vi.unstubAllGlobals() })

/** The Node takes the push, pushes it (here: the branch moves), and reports back. */
async function nodePushes(approvalId: string, commit = sha, github = githubFixture()) {
  const grant = await computePoll(f.env, nodeId, { operation: 'publish', approvalId }) as Record<string, unknown>
  github.head = commit
  await computePoll(f.env, nodeId, { operation: 'published', approvalId, ok: true })
  return grant
}

describe('factory_publish', () => {
  it('in role mode pushes the Agent’s branch without a person and opens one draft pull request', async () => {
    mode('role')
    const github = githubFixture()
    const lease = (await sync())!.lease
    const first = await publish('publish-one') as { outwardPending: boolean; approvalId: string; status: string }
    expect(first).toMatchObject({ outwardPending: true, status: 'approved' })
    expect(await publish('publish-one')).toMatchObject({ outwardPending: true, approvalId: first.approvalId })
    expect(f.db.prepare('SELECT count(*) AS n,max(status) AS status FROM agent_run_tools WHERE run_id=?').get(run.id)).toMatchObject({ n: 1, status: 'pending' })
    // No review is made in role mode: the Node is told to push the commit.
    const answer = (await sync(nodeId, lease))!
    expect(answer.review).toBeUndefined()
    expect(answer.publish).toEqual({ approvalId: first.approvalId, sha, ref: `refs/heads/l4-agent/${boxId}`, baseSha })
    const grant = await computePoll(f.env, nodeId, { operation: 'publish', approvalId: first.approvalId })
    expect(grant).toMatchObject({ remote: 'https://github.com/inchidev/afterprompt.git', ref: `refs/heads/l4-agent/${boxId}`, sha, baseSha, expectedOld: null, token: 'token-2-write' })
    // A single-repository contents write token, for this push only; the branch head was read with a read token.
    expect(github.tokens).toEqual([{ permissions: { contents: 'read' }, repositories: [11] }, { permissions: { contents: 'write' }, repositories: [11] }])
    await expect(computePoll(f.env, nodeId, { operation: 'publish', approvalId: first.approvalId })).rejects.toMatchObject({ statusCode: 403 })
    expect((await sync(nodeId, lease))!.publish).toBeUndefined()
    github.head = sha
    await computePoll(f.env, nodeId, { operation: 'published', approvalId: first.approvalId, ok: true })
    const done = await publish('publish-one')
    expect(done).toMatchObject({ published: true, sha, branch: `l4-agent/${boxId}`, pull: { number: 77, commit: sha, url: 'https://github.com/inchidev/afterprompt/pull/77' } })
    expect(f.db.prepare('SELECT status FROM agent_run_tools WHERE run_id=? AND call_id=?').get(run.id, 'publish-one')).toMatchObject({ status: 'completed' })
    expect(f.db.prepare('SELECT publication_count AS n,pull_json AS pull FROM factory_boxes WHERE id=?').get(boxId)).toMatchObject({ n: 1, pull: expect.stringContaining('"number":77') })
    // The receipt records when the provider had this head, which the merge's grace for checks counts from.
    const receipt = JSON.parse((f.db.prepare('SELECT pull_json AS pull FROM factory_boxes WHERE id=?').get(boxId) as { pull: string }).pull)
    expect(Math.abs(Date.parse(receipt.pushedAt) - Date.now())).toBeLessThan(60000)
    expect(f.db.prepare('SELECT factory_state AS state,pull_url AS url FROM tasks WHERE id=?').get('factory-task')).toMatchObject({ state: 'pr_published', url: 'https://github.com/inchidev/afterprompt/pull/77' })
    expect(github.writes.filter(write => write.path.endsWith('/pulls'))).toHaveLength(1)
    // The Server never writes Git content through the API.
    expect(github.writes.some(write => /\/git\/(?:trees|commits|refs)/u.test(write.path))).toBe(false)
    expect(await factoryFeedback(f.env, run.id)).toMatchObject({ state: 'success', commit: sha })

    // A repair is a new commit on the same branch and the same pull request.
    const second = await publish('publish-two', repair) as { approvalId: string }
    const repaired = await computePoll(f.env, nodeId, { operation: 'publish', approvalId: second.approvalId })
    expect(repaired).toMatchObject({ sha: repair, expectedOld: sha })
    github.head = repair
    await computePoll(f.env, nodeId, { operation: 'published', approvalId: second.approvalId, ok: true })
    expect(await publish('publish-two', repair)).toMatchObject({ published: true, pull: { number: 77, commit: repair } })
    expect(github.writes.filter(write => write.path.endsWith('/pulls'))).toHaveLength(1)
  })

  it('in review mode waits for the Node’s diff, then for the person to approve that exact commit', async () => {
    const github = githubFixture()
    const lease = (await sync())!.lease
    const asked = await outwardToolCall(f.env, run.id, 'factory_publish', 'publish-one', { sha, title: 'Fix failing test', body: '' }) as { approvalId: string }
    expect(asked).toMatchObject({ outwardPending: true, status: 'pending_diff' })
    const { approvalId } = asked
    expect(f.db.prepare('SELECT factory_state AS state FROM tasks WHERE id=?').get('factory-task')).toMatchObject({ state: 'approval_pending' })
    expect((await sync(nodeId, lease))!).toMatchObject({ review: { approvalId, sha, baseSha } })
    // Nothing to decide before the diff exists.
    const before = approval(approvalId)
    expect(await decideApproval(f.env, run.id, ids.owner, { id: approvalId, digest: before.digest, decision: 'approve' })).toMatchObject({ status: 'pending_diff' })
    // Only the Node holding the box may hand in its review, and it must be of the requested commit.
    await expect(submitReview(f.env, otherNode, approvalId, encoded(review()))).rejects.toMatchObject({ statusCode: 403 })
    expect(await submitReview(f.env, nodeId, approvalId, encoded(review()))).toEqual({ accepted: true })
    const pending = approval(approvalId)
    expect(pending).toMatchObject({ status: 'pending', diffKey: `factory-reviews/${boxId}/${approvalId}.json` })
    expect(pending.digest).not.toBe(before.digest)
    expect(stored.get(pending.diffKey!)).toBe(JSON.stringify(review().review))
    expect(pending.diffDigest).toBe(await factoryHash(stored.get(pending.diffKey!)!))
    expect(await approvalReview(f.env, run.id, ids.owner, approvalId)).toMatchObject({ sha, patch: '-wrong\n+right' })
    expect((await listBoxReview(f.env, run.id, ids.owner)).approvals[0]).toMatchObject({ id: approvalId, status: 'pending', diff: { digest: pending.diffDigest } })
    // Approval names the reviewed diff: the digest from before the diff no longer counts.
    await expect(decideApproval(f.env, run.id, ids.owner, { id: approvalId, digest: before.digest, decision: 'approve' })).rejects.toMatchObject({ statusCode: 409 })
    expect((await sync(nodeId, lease))!.publish).toBeUndefined()
    await expect(computePoll(f.env, nodeId, { operation: 'publish', approvalId })).rejects.toMatchObject({ statusCode: 403 })
    // A tampered stored diff is not served as the reviewed one.
    stored.set(pending.diffKey!, JSON.stringify({ ...review().review, patch: '+something else' }))
    await expect(approvalReview(f.env, run.id, ids.owner, approvalId)).rejects.toMatchObject({ statusCode: 409 })
    stored.set(pending.diffKey!, JSON.stringify(review().review))
    expect(await decideApproval(f.env, run.id, ids.owner, { id: approvalId, digest: pending.digest, decision: 'approve' })).toMatchObject({ status: 'approved', decidedBy: ids.owner })
    expect((await sync(nodeId, lease))!.publish).toMatchObject({ approvalId, sha })
    await nodePushes(approvalId, sha, github)
    expect(await outwardToolCall(f.env, run.id, 'factory_publish', 'publish-one', { sha, title: 'Fix failing test', body: '' })).toMatchObject({ published: true })
  })

  it('in review mode a rejection stands, and a review that could not be made fails the request', async () => {
    githubFixture()
    await sync()
    const rejected = await outwardToolCall(f.env, run.id, 'factory_publish', 'publish-one', { sha, title: 'Fix', body: '' }) as { approvalId: string }
    await submitReview(f.env, nodeId, rejected.approvalId, encoded(review()))
    await decideApproval(f.env, run.id, ids.owner, { id: rejected.approvalId, digest: approval(rejected.approvalId).digest, decision: 'reject' })
    expect(await outwardToolCall(f.env, run.id, 'factory_publish', 'publish-one', { sha, title: 'Fix', body: '' })).toMatchObject({ outwardPending: false, status: 'rejected' })
    expect(f.db.prepare('SELECT factory_state AS state FROM tasks WHERE id=?').get('factory-task')).toMatchObject({ state: 'rejected' })
    const unreviewable = await outwardToolCall(f.env, run.id, 'factory_publish', 'publish-two', { sha: repair, title: 'Fix', body: '' }) as { approvalId: string }
    expect(await submitReview(f.env, nodeId, unreviewable.approvalId, encoded({ ok: false, message: 'The commit does not descend from the Task’s pinned base' }))).toEqual({ accepted: false })
    expect(await outwardToolCall(f.env, run.id, 'factory_publish', 'publish-two', { sha: repair, title: 'Fix', body: '' })).toMatchObject({ outwardPending: false, status: 'failed', message: expect.stringContaining('pinned base') })
    // A review of another commit than the one asked for is refused the same way.
    const mismatched = await outwardToolCall(f.env, run.id, 'factory_publish', 'publish-three', { sha, title: 'Fix', body: '' }) as { approvalId: string }
    expect(await submitReview(f.env, nodeId, mismatched.approvalId, encoded(review(repair)))).toEqual({ accepted: false })
  })

  it('in plan mode an approved plan covers the publications after it; a new plan pauses that', async () => {
    mode('plan')
    githubFixture()
    await sync()
    expect(await factoryStatus(f.env, run.id)).toMatchObject({ approvalMode: 'plan', instruction: expect.stringContaining('factory_plan') })
    expect(await outwardToolCall(f.env, run.id, 'factory_publish', 'before-plan', { sha, title: 'Fix', body: '' })).toMatchObject({ status: 'pending_diff' })
    f.db.prepare("UPDATE factory_approvals SET status='expired' WHERE call_id='before-plan'").run()
    const plan = { summary: 'Fix the failing test', steps: ['Read the test', 'Fix it', 'Run npm test'] }
    const proposed = await outwardToolCall(f.env, run.id, 'factory_plan', 'plan', plan) as { approvalId: string }
    expect(proposed).toMatchObject({ outwardPending: true, status: 'pending' })
    const digest = approval(proposed.approvalId).digest
    await expect(decideApproval(f.env, run.id, ids.member, { id: proposed.approvalId, digest, decision: 'approve' })).rejects.toMatchObject({ statusCode: 403 })
    expect(await decideApproval(f.env, run.id, ids.owner, { id: proposed.approvalId, digest, decision: 'approve' })).toMatchObject({ status: 'approved' })
    expect(await outwardToolCall(f.env, run.id, 'factory_plan', 'plan', plan)).toMatchObject({ approved: true })
    expect(await outwardToolCall(f.env, run.id, 'factory_publish', 'covered', { sha, title: 'Fix', body: '' })).toMatchObject({ status: 'approved' })
    f.db.prepare("UPDATE factory_approvals SET status='expired' WHERE call_id='covered'").run()
    // A new plan waits for its decision; until then publications wait as in review.
    expect(await outwardToolCall(f.env, run.id, 'factory_plan', 'replan', { ...plan, summary: 'Also refactor' })).toMatchObject({ status: 'pending' })
    expect(await outwardToolCall(f.env, run.id, 'factory_publish', 'uncovered', { sha, title: 'Fix', body: '' })).toMatchObject({ status: 'pending_diff' })
  })

  it('records a plan at once in role mode and offers factory_plan only in plan mode', async () => {
    mode('role')
    expect(await outwardToolCall(f.env, run.id, 'factory_plan', 'plan', { summary: 'Fix', steps: ['Do it'] })).toMatchObject({ approved: true, message: 'Plan recorded.' })
    const names = async () => (await (await toolsForRun(f.env, await runAuthorization(f.env, run), () => {}, run)).catalog()).map(tool => tool.name)
    expect(await names()).toEqual(expect.arrayContaining(['factory_status', 'factory_publish', 'factory_feedback']))
    expect(await names()).not.toContain('factory_plan')
    expect(await names()).not.toContain('factory_workspace')
    mode('plan')
    expect(await names()).toContain('factory_plan')
  })
})

describe('after the push', () => {
  it('opens the pull request only when the branch is at exactly the approved commit', async () => {
    mode('role')
    const github = githubFixture()
    await sync()
    const { approvalId } = await publish('publish-one') as { approvalId: string }
    await computePoll(f.env, nodeId, { operation: 'publish', approvalId })
    github.head = 'f'.repeat(40)
    await expect(computePoll(f.env, nodeId, { operation: 'published', approvalId, ok: true })).rejects.toMatchObject({ statusCode: 409 })
    expect(approval(approvalId).status).toBe('uncertain')
    expect(await publish('publish-one')).toMatchObject({ outwardPending: false, status: 'uncertain', message: expect.stringContaining('look at the branch') })
    expect(github.writes.filter(write => write.path.endsWith('/pulls'))).toHaveLength(0)
    expect(f.db.prepare('SELECT publication_count AS n FROM factory_boxes WHERE id=?').get(boxId)).toMatchObject({ n: 0 })
  })

  it('stops a push when the branch moved outside L4, and reports a refused push', async () => {
    mode('role')
    const github = githubFixture()
    await sync()
    github.head = 'f'.repeat(40)
    const moved = await publish('moved') as { approvalId: string }
    await expect(computePoll(f.env, nodeId, { operation: 'publish', approvalId: moved.approvalId })).rejects.toMatchObject({ statusCode: 409 })
    expect(approval(moved.approvalId).status).toBe('failed')
    expect(github.tokens.some(token => (token.permissions as { contents: string }).contents === 'write')).toBe(false)
    github.head = null
    const refused = await publish('refused') as { approvalId: string }
    await computePoll(f.env, nodeId, { operation: 'publish', approvalId: refused.approvalId })
    await computePoll(f.env, nodeId, { operation: 'published', approvalId: refused.approvalId, ok: false, message: 'remote rejected' })
    expect(await publish('refused')).toMatchObject({ outwardPending: false, status: 'failed', message: expect.stringContaining('remote rejected') })
  })

  it('keeps every push to the Node holding the box under its lease', async () => {
    mode('role')
    githubFixture()
    await sync()
    const { approvalId } = await publish('publish-one') as { approvalId: string }
    await expect(computePoll(f.env, otherNode, { operation: 'publish', approvalId })).rejects.toMatchObject({ statusCode: 403 })
    f.db.prepare("UPDATE factory_boxes SET lease_until='2000-01-01' WHERE id=?").run(boxId)
    await expect(computePoll(f.env, nodeId, { operation: 'publish', approvalId })).rejects.toMatchObject({ statusCode: 403 })
  })
})

describe('the push grant', () => {
  it('is a single-repository contents write token, revoked when the publication is withdrawn while it is issued', async () => {
    const github = githubFixture()
    expect(await githubPushGrant(f.env, { installationId: 101, repositoryId: 11 }, async () => {})).toBe('token-1-write')
    expect(github.tokens).toEqual([{ permissions: { contents: 'write' }, repositories: [11] }])
    let checks = 0
    await expect(githubPushGrant(f.env, { installationId: 101, repositoryId: 11 }, async () => { if (++checks === 2) throw new Error('withdrawn') })).rejects.toThrow('withdrawn')
    expect(github.revoked).toEqual(['Bearer token-2-write'])
  })
})

describe('the tool call', () => {
  it('keeps one audit row while it waits and refuses a changed request under the same identity', async () => {
    mode('role')
    githubFixture()
    await publish('publish-one')
    await expect(executeRunTool(f.env, run.id, { callId: 'publish-one', name: 'factory_publish', arguments: { sha: repair, title: 'Other', body: '' } }, () => {})).rejects.toMatchObject({ statusCode: 409 })
    // One publication waits at a time.
    await expect(publish('publish-two', repair)).rejects.toMatchObject({ statusCode: 409 })
    expect((await findAgentRun(f.env, run.id))?.status).toBe('running')
  })

  it('returns a corrective 400 for invalid arguments without echoing them', async () => {
    const input = { callId: 'invalid', name: 'factory_publish', arguments: { sha: 'not-a-sha', title: 'PRIVATE_INPUT_MUST_NOT_BE_ECHOED' } }
    const response = await agentGateway(new Request('https://server.example/tools', { method: 'POST', headers: { Authorization: 'Bearer ' + await runCapability(f.env, run.id) }, body: JSON.stringify(input) }), f.env, run.id, 'tools', () => {})
    expect(response.status).toBe(400)
    const body = await response.text()
    expect(body).toContain('Invalid tool arguments: ')
    expect(body).not.toContain('PRIVATE_INPUT_MUST_NOT_BE_ECHOED')
    expect(f.db.prepare('SELECT count(*) AS n FROM factory_approvals').get()).toMatchObject({ n: 0 })
    expect((await findAgentRun(f.env, run.id))?.status).toBe('running')
  })

  it('finds every currently permitted tool by exact identity through the real discovery surface', async () => {
    const tools = await toolsForRun(f.env, await runAuthorization(f.env, run), () => {}, run)
    const permitted = await tools.catalog()
    for (const tool of permitted) {
      const found = await tools.call('search_tools', { query: tool.name }) as { tools: Array<{ name: string }> }
      expect(found.tools[0]?.name, tool.name).toBe(tool.name)
    }
    const found = await tools.call('search_tools', { query: 'repository', limit: 8 }) as { tools: Array<{ name: string }> }
    expect(found.tools.map(tool => tool.name)).toEqual(expect.arrayContaining(['factory_status']))
  })
})

it('refuses a remote pairing that impersonates the managed Cloudflare provider without consuming its pairing code', async () => {
  const auth = await runAuthorization(f.env, run)
  const owner = { ...auth, principal: { ...auth.principal, id: ids.owner, kind: 'human' as const, isOwner: true }, credential: { kind: 'session' as const }, delegation: undefined }
  const code = await prepareComputePairing(f.env, owner, 'Remote Docker')
  const forged = { provider: 'cloudflare-containers', diskBytes: 8000000000, docker: false, durableDisk: false, isolation: 'container-vm', image, capacity: { cpu: 2, memoryMiB: 16384, boxes: 4 }, protocol: 2, memoryMiB: 4096, cpu: 0.5, processLimit: 128, codeBytes: 500000000, timeoutMs: 120000 }
  await expect(pairComputeNode(f.env, code.token, forged as never)).rejects.toThrow()
  expect(f.db.prepare('SELECT count(*) AS total FROM compute_pairings').get()).toMatchObject({ total: 1 })
  expect(await pairComputeNode(f.env, code.token, capabilities)).toHaveProperty('nodeId')
})

it('reads a stored execution policy that still carries the per-command limits', async () => {
  const { agentExecutionPolicy } = await import('../../server/utils/agent-execution-policy')
  f.db.prepare('UPDATE server_settings SET value=? WHERE key=?').run(JSON.stringify({ mode: 'plan', workspaceActions: 2000, workspaceRuntimeMs: 3600000, workspacePublications: 10, publications: 7 }), 'agents.executionPolicy')
  expect(await agentExecutionPolicy(f.env)).toMatchObject({ mode: 'plan', publications: 7, boxRuntimeMs: 21600000 })
  expect(await agentExecutionPolicy(f.env)).not.toHaveProperty('workspaceActions')
  const { agentExecutionPolicySchema } = await import('../../shared/agent-execution-policy')
  // A new setting is still strict: it cannot carry them.
  expect(() => agentExecutionPolicySchema.parse({ workspaceActions: 10 })).toThrow()
})
