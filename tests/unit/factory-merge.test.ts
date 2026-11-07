import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { generateKeyPairSync } from 'node:crypto'
import { mcpFixture, ids, grant } from '../helpers/outbound-mcp'
import { ALL_PERMISSIONS, Permission } from '../../shared/permissions'
import { DEFAULT_GIT_FLOW, projectGitFlowSchema, type ProjectGitFlow } from '../../shared/project-factory'
import { factoryHash } from '../../server/utils/factory-authority'
import { computePoll } from '../../server/utils/compute-nodes'
import { ensureBox } from '../../server/utils/factory-boxes'
import { personMerge, taskMergeState } from '../../server/utils/factory-merge'
import { getProjectGitFlow, saveProjectGitFlow } from '../../server/utils/project-git-flow'
import { factoryStatus } from '../../server/utils/factory-status'
import { connectGitea } from '../../server/utils/gitea'
import { findAgentRun, runAuthorization } from '../../server/utils/agent-run-service'
import { executeRunTool, toolsForRun } from '../../server/utils/agent-tools'
import type { AgentRun } from '../../shared/agent-execution'

const nodeId = '00000000-0000-4000-8000-000000000099', image = 'registry.example/l4@sha256:' + 'a'.repeat(64)
const capabilities = { diskBytes: 1073741824 as const, docker: true as const, durableDisk: true as const, isolation: 'shared-kernel' as const, image, capacity: { cpu: 4, memoryMiB: 16384, boxes: 4 }, protocol: 2 as const }
const config = { name: 'Afterprompt', computeNodeId: nodeId, sourceRepo: 'inchidev/afterprompt', sourceRepoId: 11, sourceInstallationId: 101,
  workRepo: 'inchidev/afterprompt', workRepoId: 11, workInstallationId: 101, baseBranch: 'main', requiredChecks: ['test'], previewHosts: ['vercel.app'] }
const baseSha = 'a'.repeat(40), sha = 'c'.repeat(40), moved = 'd'.repeat(40), mergeSha = '9'.repeat(40)
let f: ReturnType<typeof mcpFixture>, run: AgentRun, boxId: string

/** GitHub as the merge sees it: refs, the Task's pull request, its checks and the merge endpoint. */
function githubFixture() {
  const state = { refs: {} as Record<string, string>, head: sha, draft: true, merged: false, check: 'success' as 'success' | 'failure' | 'in_progress', refuse: null as null | { status: number; message: string },
    compare: 'ahead', tokens: [] as unknown[], merges: [] as Array<Record<string, unknown>>, readied: 0, pulls: 0 }
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL, options: RequestInit = {}) => {
    const parsed = new URL(String(url)), path = parsed.pathname, method = options.method ?? 'GET', body = options.body ? JSON.parse(String(options.body)) : {}
    expect(parsed.origin).toBe('https://api.github.com')
    if (path.endsWith('/access_tokens')) { state.tokens.push(body.permissions); return Response.json({ token: `token-${state.tokens.length}` }) }
    if (path === '/installation/token') return new Response(null, { status: 204 })
    if (path === '/graphql') { expect(body.variables).toEqual({ id: 'PR_node77' }); state.readied++; state.draft = false; return Response.json({ data: { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } } }) }
    const ref = /^\/repos\/inchidev\/afterprompt\/git\/ref\/heads\/(.+)$/u.exec(path)?.[1]
    if (ref) return state.refs[ref] ? Response.json({ object: { sha: state.refs[ref] } }) : Response.json({ message: 'Not Found' }, { status: 404 })
    const compare = /\/compare\/([a-f0-9]{40})\.\.\.([a-f0-9]{40})$/u.exec(path)
    if (compare) return Response.json({ status: state.compare, merge_base_commit: { sha: state.compare === 'ahead' ? compare[1] : baseSha } })
    const pull = () => ({ number: 77, node_id: 'PR_node77', state: state.merged ? 'closed' : 'open', draft: state.draft, merged: state.merged, mergeable_state: 'clean', html_url: '',
      head: { sha: state.head, ref: `l4-agent/${boxId}`, repo: { id: 11 } }, base: { ref: 'main', repo: { id: 11 } } })
    if (path.endsWith('/pulls') && method === 'GET') { state.pulls++; return Response.json([]) }
    if (path.endsWith('/pulls') && method === 'POST') { state.pulls++; return Response.json(pull()) }
    if (path.endsWith('/pulls/77/merge') && method === 'PUT') {
      state.merges.push(body)
      if (state.refuse) return Response.json({ message: state.refuse.message, documentation_url: 'https://docs.github.com' }, { status: state.refuse.status })
      if (body.sha !== state.head) return Response.json({ message: 'Head branch was modified. Review and try the merge again.' }, { status: 409 })
      state.merged = true
      return Response.json({ sha: mergeSha, merged: true, message: 'Pull Request successfully merged' })
    }
    if (path.endsWith('/pulls/77')) return Response.json(pull())
    if (path.endsWith('/check-runs')) return Response.json({ total_count: 1, check_runs: [{ name: 'test', head_sha: state.head, status: state.check === 'in_progress' ? 'in_progress' : 'completed', conclusion: state.check === 'in_progress' ? null : state.check, details_url: null }] })
    if (path.endsWith('/statuses')) return Response.json([])
    if (path.endsWith('/deployments')) return Response.json([])
    if (path.endsWith('/actions/runs')) return Response.json({ total_count: 0, workflow_runs: [] })
    throw new Error('Unexpected GitHub fixture endpoint ' + method + ' ' + path)
  }))
  return state
}
const flow = (gitFlow: Partial<ProjectGitFlow>) => f.db.prepare('UPDATE projects SET factory_json=? WHERE id=?').run(JSON.stringify({ gitFlow: { ...DEFAULT_GIT_FLOW, ...gitFlow } }), 'proj')
const withPull = (commit = sha) => f.db.prepare('UPDATE factory_boxes SET pull_json=? WHERE id=?')
  .run(JSON.stringify({ number: 77, commit, branch: `l4-agent/${boxId}`, url: 'https://github.com/inchidev/afterprompt/pull/77' }), boxId)
const merges = () => f.db.prepare("SELECT status,decided_by AS decidedBy,request_json AS request,result_json AS result FROM factory_approvals WHERE kind='merge' ORDER BY created_at").all() as Array<{ status: string; decidedBy: string | null; request: string; result: string | null }>
const taskState = () => f.db.prepare('SELECT status,factory_state AS factoryState FROM tasks WHERE id=?').get('factory-task') as { status: string; factoryState: string | null }
const mergeTool = (callId: string, commit = sha) => executeRunTool(f.env, run.id, { callId, name: 'factory_merge', arguments: { sha: commit } }, () => {})
const toolNames = async () => (await (await toolsForRun(f.env, await runAuthorization(f.env, run), () => {}, run)).catalog()).map(tool => tool.name)
const sync = async (lease?: string) => (await computePoll(f.env, nodeId, { operation: 'sync', capacity: { cpu: 4, memoryMiB: 16384, boxes: 4, diskFree: 1e10 },
  boxes: lease ? [{ id: boxId, lease, state: 'running', runId: run.id, runtimeMs: 0 }] : [] }) as { boxes: Array<{ id: string; lease: string; publish?: Record<string, unknown> }> }).boxes.find(box => box.id === boxId)
function mode(value: 'role' | 'review') {
  const mandate = JSON.parse(run.mandateJson)
  mandate.execution = { ...mandate.execution, mode: value }
  f.db.prepare('UPDATE agent_runs SET mandate_json=? WHERE id=?').run(JSON.stringify(mandate), run.id)
  run = { ...run, mandateJson: JSON.stringify(mandate) }
}

beforeEach(async () => {
  f = mcpFixture()
  const now = new Date().toISOString()
  f.db.prepare('INSERT INTO server_settings(key,value,updated_at) VALUES(?,?,?)').run('agents.executionPolicy', JSON.stringify({ mode: 'review' }), now)
  f.db.prepare('UPDATE roles SET permissions_bitmask=? WHERE id=?').run(ALL_PERMISSIONS, ids.agentRole)
  f.db.prepare('INSERT INTO task_boards(id,name,created_by) VALUES(?,?,?)').run('factory-board', 'Factory', ids.owner)
  f.db.prepare("INSERT INTO tasks(id,board_id,title,assignee_id,created_by,status) VALUES(?,?,?,?,?,'ready')").run('factory-task', 'factory-board', 'Fix failing test', ids.agent, ids.owner)
  const created = await f.run(ids.owner, undefined, 'factory-task')
  f.db.prepare('INSERT INTO compute_nodes(id,name,token_hash,capabilities_json,last_seen,created_by,created_at) VALUES(?,?,?,?,?,?,?)').run(nodeId, 'Node', await factoryHash('node-token'), JSON.stringify(capabilities), now, ids.owner, now)
  f.db.prepare('INSERT INTO agent_environments(id,config_json,created_by,created_at,updated_at) VALUES(?,?,?,?,?)').run('factory-env', JSON.stringify(config), ids.owner, now, now)
  f.db.prepare('UPDATE tasks SET environment_id=? WHERE id=?').run('factory-env', 'factory-task')
  // The repository belongs to a Project, whose Git flow it follows.
  f.db.prepare('INSERT INTO projects(id,name,created_by,created_at,updated_at) VALUES(?,?,?,?,?)').run('proj', 'Afterprompt', ids.owner, now, now)
  f.db.prepare("INSERT INTO project_repositories(id,project_id,provider,host,external_id,slug,default_branch,environment_id,created_by,created_at) VALUES('repo','proj','github','https://github.com','11','inchidev/afterprompt','main','factory-env',?,?)").run(ids.owner, now)
  const mandate = { ...JSON.parse(created.run.mandateJson), environmentId: 'factory-env', environmentVersion: 1 }
  f.db.prepare('UPDATE agent_runs SET environment_json=?,mandate_json=? WHERE id=?').run(JSON.stringify({ ...config, id: 'factory-env', enabled: true, version: 1, baseSha, baseTreeSha: 'b'.repeat(40) }), JSON.stringify(mandate), created.run.id)
  run = (await findAgentRun(f.env, created.run.id))!
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 })
  f.env.GITHUB_AGENT_APP_ID = '4242'; f.env.GITHUB_AGENT_APP_PRIVATE_KEY = pair.privateKey.export({ type: 'pkcs1', format: 'pem' }).toString()
  boxId = await ensureBox(f.env, run, nodeId)
})
afterEach(() => { f.db.close(); vi.unstubAllGlobals() })

describe('a Project’s Git flow', () => {
  it('defaults to a person merging l4-agent/<box> by squash, and is changed by whoever manages the Project', async () => {
    const owner = await f.actor()
    expect(await getProjectGitFlow(f.env, owner, 'proj')).toMatchObject({ gitFlow: { branchPrefix: 'l4-agent/', merge: 'person', method: 'squash' }, canManage: true })
    await expect(saveProjectGitFlow(f.env, await f.actor(ids.member), 'proj', { merge: 'direct_push' })).rejects.toMatchObject({ statusCode: 403 })
    expect((await saveProjectGitFlow(f.env, owner, 'proj', { branchPrefix: 'agents/', merge: 'agent_after_checks', method: 'rebase' })).gitFlow).toEqual({ branchPrefix: 'agents/', merge: 'agent_after_checks', method: 'rebase' })
    // The network part of the same settings stays as it was.
    f.db.prepare("UPDATE projects SET factory_json=json_set(factory_json,'$.network',json('{\"presets\":[\"npm\"],\"hosts\":[]}')) WHERE id='proj'").run()
    await saveProjectGitFlow(f.env, owner, 'proj', { merge: 'person' })
    expect(JSON.parse(String((f.db.prepare('SELECT factory_json AS json FROM projects WHERE id=?').get('proj') as { json: string }).json))).toEqual({ gitFlow: { branchPrefix: 'l4-agent/', merge: 'person', method: 'squash' }, network: { presets: ['npm'], hosts: [] } })
  })

  it('accepts only a plain branch prefix and known merge modes and methods', () => {
    for (const prefix of ['l4-agent/', 'agents/l4/', 'bot-', 'team_x/ai_']) expect(projectGitFlowSchema.safeParse({ branchPrefix: prefix }).success, prefix).toBe(true)
    for (const prefix of ['', 'l4-agent', '../x/', 'a//b/', 'refs/heads/x/', 'x.lock/', '.hidden/', 'a b/', 'a@{1}/', 'x/./', 'main~1/'])
      expect(projectGitFlowSchema.safeParse({ branchPrefix: prefix }).success, prefix).toBe(false)
    expect(projectGitFlowSchema.safeParse({ merge: 'agent' }).success).toBe(false)
    expect(projectGitFlowSchema.safeParse({ method: 'fast-forward' }).success).toBe(false)
    expect(projectGitFlowSchema.safeParse({ target: 'release' }).success).toBe(false)
  })
})

describe('the push target', () => {
  it('is the Project’s branch prefix and the box’s id', async () => {
    mode('role')
    flow({ branchPrefix: 'agents/' })
    const github = githubFixture()
    const lease = (await sync())!.lease
    const asked = await executeRunTool(f.env, run.id, { callId: 'one', name: 'factory_publish', arguments: { sha, title: 'Fix', body: '' } }, () => {}) as { approvalId: string }
    expect((await sync(lease))!.publish).toEqual({ approvalId: asked.approvalId, sha, ref: `refs/heads/agents/${boxId}`, baseSha })
    expect(await computePoll(f.env, nodeId, { operation: 'publish', approvalId: asked.approvalId })).toMatchObject({ ref: `refs/heads/agents/${boxId}`, expectedOld: null })
    github.refs[`agents/${boxId}`] = sha
    github.head = sha
    // The pull request's own fixture branch is l4-agent/<box>, so only the read-back is checked here.
    await computePoll(f.env, nodeId, { operation: 'published', approvalId: asked.approvalId, ok: true }).catch(() => undefined)
    expect(await factoryStatus(f.env, run.id)).toMatchObject({ branch: `agents/${boxId}`, gitFlow: { branchPrefix: 'agents/' } })
  })

  it('under direct_push is the base branch, as a fast-forward from its head, with no pull request', async () => {
    mode('role')
    flow({ merge: 'direct_push' })
    const github = githubFixture()
    github.refs.main = baseSha
    const lease = (await sync())!.lease
    expect(await factoryStatus(f.env, run.id)).toMatchObject({ branch: 'main', instruction: expect.stringContaining('fast-forward') })
    const asked = await executeRunTool(f.env, run.id, { callId: 'one', name: 'factory_publish', arguments: { sha, title: 'Fix', body: '' } }, () => {}) as { approvalId: string }
    expect((await sync(lease))!.publish).toEqual({ approvalId: asked.approvalId, sha, ref: 'refs/heads/main', baseSha, direct: true })
    expect(await computePoll(f.env, nodeId, { operation: 'publish', approvalId: asked.approvalId })).toMatchObject({ ref: 'refs/heads/main', sha, expectedOld: baseSha, direct: true })
    github.refs.main = sha
    await computePoll(f.env, nodeId, { operation: 'published', approvalId: asked.approvalId, ok: true })
    expect(await executeRunTool(f.env, run.id, { callId: 'one', name: 'factory_publish', arguments: { sha, title: 'Fix', body: '' } }, () => {})).toMatchObject({ published: true, direct: true, branch: 'main', sha })
    expect(github.pulls).toBe(0)
    expect(f.db.prepare('SELECT pushed_sha AS pushed,pull_json AS pull,publication_count AS n FROM factory_boxes WHERE id=?').get(boxId)).toEqual({ pushed: sha, pull: null, n: 1 })
    expect(taskState().factoryState).toBe('pushed')
    expect(await taskMergeState(f.env, await f.actor(), 'factory-task')).toMatchObject({ box: { pushedSha: sha, pull: null, branch: 'main' }, canMerge: false })

    // The next push replaces the head the first one left, and only as a fast-forward.
    const next = await executeRunTool(f.env, run.id, { callId: 'two', name: 'factory_publish', arguments: { sha: moved, title: 'More', body: '' } }, () => {}) as { approvalId: string }
    expect(await computePoll(f.env, nodeId, { operation: 'publish', approvalId: next.approvalId })).toMatchObject({ expectedOld: sha })
    github.refs.main = moved
    github.compare = 'diverged'
    await computePoll(f.env, nodeId, { operation: 'published', approvalId: next.approvalId, ok: true })
    expect(await executeRunTool(f.env, run.id, { callId: 'two', name: 'factory_publish', arguments: { sha: moved, title: 'More', body: '' } }, () => {}))
      .toMatchObject({ outwardPending: false, status: 'uncertain', message: expect.stringContaining('fast-forward') })
    expect((f.db.prepare('SELECT pushed_sha AS pushed FROM factory_boxes WHERE id=?').get(boxId) as { pushed: string }).pushed).toBe(sha)
  })

  it('under direct_push refuses a base branch that is not there', async () => {
    mode('role')
    flow({ merge: 'direct_push' })
    githubFixture()
    await sync()
    const asked = await executeRunTool(f.env, run.id, { callId: 'one', name: 'factory_publish', arguments: { sha, title: 'Fix', body: '' } }, () => {}) as { approvalId: string }
    await expect(computePoll(f.env, nodeId, { operation: 'publish', approvalId: asked.approvalId })).rejects.toMatchObject({ statusCode: 409 })
  })
})

describe('a person’s merge', () => {
  it('needs Approve agent actions in the repository’s Project, merges the approved head by the Project’s method and records it', async () => {
    flow({ method: 'rebase' })
    const github = githubFixture()
    withPull()
    const member = await f.actor(ids.member)
    expect(await taskMergeState(f.env, member, 'factory-task')).toMatchObject({ canMerge: false, ready: true })
    await expect(personMerge(f.env, member, 'factory-task', { sha })).rejects.toMatchObject({ statusCode: 403 })
    expect(github.merges).toEqual([])
    f.db.prepare('UPDATE roles SET permissions_bitmask=? WHERE id=?').run(grant | Permission.useAgents | Permission.approveAgentActions, ids.memberRole)
    const allowed = await f.actor(ids.member)
    expect(await taskMergeState(f.env, allowed, 'factory-task')).toMatchObject({ canMerge: true, ready: true, reason: null })
    expect(await personMerge(f.env, allowed, 'factory-task', { sha })).toMatchObject({ box: { pull: { number: 77, merged: { sha: mergeSha, method: 'rebase', by: 'person' } } }, reason: 'Merged.' })
    // The draft is taken out of draft first; the merge names the exact approved head.
    expect(github.readied).toBe(1)
    expect(github.merges).toEqual([{ sha, merge_method: 'rebase' }])
    expect(github.tokens).toContainEqual({ contents: 'write', pull_requests: 'write' })
    expect(merges()).toEqual([expect.objectContaining({ status: 'completed', decidedBy: ids.member })])
    expect(JSON.parse(merges()[0]!.request)).toEqual({ sha, number: 77, method: 'rebase', by: 'person' })
    // The board says so; the Task's own status is the people's.
    expect(taskState()).toEqual({ status: 'ready', factoryState: 'merged' })
    await expect(personMerge(f.env, allowed, 'factory-task', { sha })).rejects.toMatchObject({ statusCode: 409 })
    expect(github.merges).toHaveLength(1)
  })

  it('refuses a head that moved, before anything is merged', async () => {
    const github = githubFixture()
    withPull()
    const owner = await f.actor()
    await expect(personMerge(f.env, owner, 'factory-task', { sha: moved })).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('approved head') })
    // Moved on GitHub after the approval: the checks of the old head do not count.
    github.head = moved
    await expect(personMerge(f.env, owner, 'factory-task', { sha })).rejects.toMatchObject({ statusCode: 409 })
    expect(github.merges).toEqual([])
    expect(merges()).toEqual([])
  })

  it('waits until the checks pass, with the reason', async () => {
    const github = githubFixture()
    withPull()
    const owner = await f.actor()
    github.check = 'in_progress'
    expect(await taskMergeState(f.env, owner, 'factory-task')).toMatchObject({ canMerge: true, ready: false, reason: expect.stringContaining('still running') })
    await expect(personMerge(f.env, owner, 'factory-task', { sha })).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('still running') })
    github.check = 'failure'
    await expect(personMerge(f.env, owner, 'factory-task', { sha })).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('failed') })
    expect(github.merges).toEqual([])
  })

  it('reports GitHub’s refusal with its reason and never works around it', async () => {
    const github = githubFixture()
    withPull()
    github.refuse = { status: 405, message: 'At least 1 approving review is required by reviewers with write access.' }
    await expect(personMerge(f.env, await f.actor(), 'factory-task', { sha })).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('At least 1 approving review is required') })
    expect(github.merges).toHaveLength(1)
    expect(merges()).toEqual([expect.objectContaining({ status: 'failed', result: expect.stringContaining('GitHub refused the merge: At least 1 approving review') })])
    expect(taskState().factoryState).toBe('merge_failed')
    expect(JSON.parse(String((f.db.prepare('SELECT pull_json AS pull FROM factory_boxes WHERE id=?').get(boxId) as { pull: string }).pull)).merged).toBeUndefined()
  })

  it('is not offered under direct_push', async () => {
    flow({ merge: 'direct_push' })
    githubFixture()
    withPull()
    expect(await taskMergeState(f.env, await f.actor(), 'factory-task')).toMatchObject({ canMerge: false, ready: false })
    await expect(personMerge(f.env, await f.actor(), 'factory-task', { sha })).rejects.toMatchObject({ statusCode: 409 })
  })

  it('merges a Gitea pull request with its method as Do and the approved head, out of WIP first', async () => {
    const host = 'https://git.example.test', token = 'a'.repeat(40)
    const connection = await connectGitea(f.env, await f.actor(), { host, token }, vi.fn(async (url: string | URL | Request) =>
      String(url).endsWith('/user') ? Response.json({ id: 7, login: 'l4-bot' }) : Response.json([])))
    const environment = { ...JSON.parse(String((f.db.prepare('SELECT environment_json AS json FROM factory_boxes WHERE id=?').get(boxId) as { json: string }).json)),
      provider: 'gitea', gitConnectionId: connection.id, sourceInstallationId: 0, workInstallationId: 0 }
    f.db.prepare('UPDATE factory_boxes SET environment_json=? WHERE id=?').run(JSON.stringify(environment), boxId)
    withPull()
    flow({ method: 'squash' })
    const calls: Array<{ method: string; path: string; body: Record<string, unknown> }> = []
    let merged = false, title = 'WIP: Fix failing test'
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL, options: RequestInit = {}) => {
      const parsed = new URL(String(url)), path = parsed.pathname.replace('/api/v1', ''), method = options.method ?? 'GET', body = options.body ? JSON.parse(String(options.body)) : {}
      expect(parsed.origin).toBe(host)
      calls.push({ method, path, body })
      const pull = () => ({ number: 77, state: merged ? 'closed' : 'open', merged, title, mergeable: true, merge_commit_sha: merged ? mergeSha : null,
        head: { ref: `l4-agent/${boxId}`, sha, repo: { id: 11 } }, base: { ref: 'main', repo: { id: 11 } } })
      if (path === '/repos/inchidev/afterprompt/pulls/77' && method === 'PATCH') { title = String(body.title); return Response.json(pull()) }
      if (path === '/repos/inchidev/afterprompt/pulls/77') return Response.json(pull())
      if (path.startsWith('/repos/inchidev/afterprompt/commits/')) return Response.json(parsed.searchParams.get('page') === '1' ? [{ context: 'test', status: 'success', target_url: null }] : [])
      if (path === '/repos/inchidev/afterprompt/pulls/77/merge') { merged = true; return new Response(null, { status: 200 }) }
      throw new Error('Unexpected Gitea fixture endpoint ' + method + ' ' + path)
    }))
    expect(await personMerge(f.env, await f.actor(), 'factory-task', { sha })).toMatchObject({ box: { pull: { merged: { sha: mergeSha, method: 'squash' } } } })
    expect(calls.find(call => call.method === 'PATCH')?.body).toEqual({ title: 'Fix failing test' })
    expect(calls.find(call => call.path.endsWith('/merge'))).toMatchObject({ method: 'POST', body: { Do: 'squash', head_commit_id: sha, delete_branch_after_merge: false } })
    expect(merges()).toEqual([expect.objectContaining({ status: 'completed' })])
  })
})

describe('factory_merge', () => {
  it('is offered only under agent_after_checks and refused elsewhere', async () => {
    githubFixture()
    withPull()
    expect(await toolNames()).not.toContain('factory_merge')
    await expect(mergeTool('merge-person')).rejects.toMatchObject({ statusCode: 403 })
    flow({ merge: 'direct_push' })
    expect(await toolNames()).not.toContain('factory_merge')
    flow({ merge: 'agent_after_checks' })
    expect(await toolNames()).toContain('factory_merge')
    expect(await factoryStatus(f.env, run.id)).toMatchObject({ instruction: expect.stringContaining('factory_merge') })
  })

  it('merges only once every check of the approved head passed, once per call', async () => {
    flow({ merge: 'agent_after_checks', method: 'merge' })
    const github = githubFixture()
    withPull()
    github.check = 'in_progress'
    await expect(mergeTool('too-early')).rejects.toMatchObject({ statusCode: 409 })
    github.check = 'success'
    await expect(mergeTool('wrong-head', moved)).rejects.toMatchObject({ statusCode: 409 })
    expect(github.merges).toEqual([])
    expect(await mergeTool('merge')).toMatchObject({ merged: true, sha: mergeSha, method: 'merge', status: 'completed', outwardPending: false })
    expect(await mergeTool('merge')).toMatchObject({ merged: true, status: 'completed' })
    expect(github.merges).toEqual([{ sha, merge_method: 'merge' }])
    expect(merges()).toEqual([expect.objectContaining({ status: 'completed', decidedBy: null, request: expect.stringContaining('"by":"agent"') })])
    expect(taskState().factoryState).toBe('merged')
  })

  it('returns GitHub’s refusal to the Agent', async () => {
    flow({ merge: 'agent_after_checks' })
    const github = githubFixture()
    withPull()
    github.refuse = { status: 405, message: 'Required status check "deploy" is expected.' }
    expect(await mergeTool('merge')).toMatchObject({ status: 'failed', message: 'GitHub refused the merge: Required status check "deploy" is expected.' })
  })
})
