import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mcpFixture, ids } from '../helpers/outbound-mcp'
import { fakeArtifacts, type FakeArtifacts } from '../helpers/artifacts'
import { ALL_PERMISSIONS, Permission } from '../../shared/permissions'
import { codeEnvironmentSchema, repositoryResourceId } from '../../shared/code-environments'
import { DEFAULT_GIT_FLOW, type ProjectGitFlow } from '../../shared/project-factory'
import { projectRepositoryName, projectReleaseSchema } from '../../shared/software-factory'
import { factoryHash } from '../../server/utils/factory-authority'
import { ensureBox } from '../../server/utils/factory-boxes'
import { findAgentRun } from '../../server/utils/agent-run-service'
import { ARTIFACTS_NO_CHECKS_REASON, artifactsAvailability, artifactsTransport, createProjectRelease, createProjectRepository, listProjectReleases } from '../../server/utils/factory-artifacts'
import { gitAgentConfigured } from '../../server/utils/git-provider'
import { personMerge, taskMergeState } from '../../server/utils/factory-merge'
import { computePublish, publishedApproval } from '../../server/utils/factory-approvals'
import { factoryStatus } from '../../server/utils/factory-status'
import { executeRunTool } from '../../server/utils/agent-tools'
import { pack, pktLine } from '../../server/utils/git-pack'
import { BoxOutbound, type BoxEgress } from '../../workers/factory-outbound'
import type { AgentRun } from '../../shared/agent-execution'
import type { RunEnvironment } from '../../shared/code-environments'

vi.mock('cloudflare:workers', () => ({
  WorkerEntrypoint: class { constructor(protected ctx: unknown, protected env: unknown) {} },
  DurableObject: class { constructor(protected ctx: unknown, protected env: unknown) {} },
}))

const nodeId = '00000000-0000-4000-8000-000000000099', image = 'registry.cloudflare.com/account/factory@sha256:' + 'a'.repeat(64)
const capabilities = { provider: 'cloudflare-containers', diskBytes: 8000000000, docker: false, durableDisk: false, isolation: 'container-vm', image,
  capacity: { cpu: 0.5, memoryMiB: 4096, boxes: 1 }, protocol: 2, memoryMiB: 4096, cpu: 0.5, processLimit: 128, codeBytes: 500000000, timeoutMs: 120000 }
const baseSha = 'a'.repeat(40), baseTree = 'b'.repeat(40), sha = 'c'.repeat(40), tree = 'd'.repeat(40), moved = 'e'.repeat(40), zero = '0'.repeat(40)
let f: ReturnType<typeof mcpFixture>, fake: FakeArtifacts, run: AgentRun, boxId: string, environment: RunEnvironment
const lease = 'f'.repeat(64)

/** The Project's repository as the Server attaches it: the box works on `game`, whose main is at the pinned base. */
async function attachGame() {
  const created = await fake.binding.create('game', { setDefaultBranch: 'main' })
  await (await fake.binding.get('game')).revokeToken(created.token)
  fake.seed('game', { hash: baseSha, treeHash: baseTree, parents: [], message: 'Create Game' }, { 'refs/heads/main': baseSha })
  const config = { provider: 'artifacts' as const, name: 'Game', computeNodeId: nodeId, gitConnectionId: null, sourceRepo: 'game', sourceRepoId: 0, sourceInstallationId: 0, workRepo: 'game', workRepoId: 0, workInstallationId: 0,
    repositoryId: created.id, remote: created.remote, baseBranch: 'main', requiredChecks: [], previewHosts: [] }
  const now = new Date().toISOString()
  f.db.prepare('INSERT INTO agent_environments(id,config_json,created_by,created_at,updated_at) VALUES(?,?,?,?,?)').run('game-env', JSON.stringify(config), ids.owner, now, now)
  f.db.prepare("INSERT INTO project_repositories(id,project_id,provider,host,external_id,slug,default_branch,environment_id,created_by,created_at) VALUES('game-repo','proj','artifacts',?,?,'game','main','game-env',?,?)").run(new URL(created.remote).origin, created.id, ids.owner, now)
  f.db.prepare("INSERT INTO tasks(id,board_id,title,assignee_id,created_by,status,environment_id) VALUES('game-task','factory-board','Add a level',?,?,'ready','game-env')").run(ids.agent, ids.owner)
  const created2 = await f.run(ids.owner, undefined, 'game-task')
  environment = { ...config, id: 'game-env', enabled: true, version: 1, baseSha, baseTreeSha: baseTree }
  f.db.prepare('UPDATE agent_runs SET environment_json=?,mandate_json=? WHERE id=?').run(JSON.stringify(environment), JSON.stringify({ ...JSON.parse(created2.run.mandateJson), environmentId: 'game-env', environmentVersion: 1, execution: { mode: 'role' } }), created2.run.id)
  run = (await findAgentRun(f.env, created2.run.id))!
  boxId = await ensureBox(f.env, run, nodeId)
  f.db.prepare("UPDATE factory_boxes SET status='running',lease_token=?,lease_until=? WHERE id=?").run(lease, new Date(Date.now() + 60000).toISOString(), boxId)
}
const branch = () => `l4-agent/${boxId}`
/** The box pushed its commit to its branch: the repository holds it, descending from the base. */
const pushedBranch = (commit = sha, parents = [baseSha]) => fake.seed('game', { hash: commit, treeHash: tree, parents, message: 'Add a level' }, { [`refs/heads/${branch()}`]: commit })
/** The box published `commit`: its approval completed and the Task carries the receipt, as publishedApproval leaves them. */
function withReceipt(commit = sha) {
  if (!f.db.prepare("SELECT 1 FROM factory_approvals WHERE kind='publish' AND status='completed' AND json_extract(request_json,'$.sha')=?").get(commit)) approval('completed', { sha: commit })
  f.db.prepare('UPDATE factory_boxes SET pull_json=? WHERE id=?').run(JSON.stringify({ number: 0, commit, branch: branch(), url: `https://server.example/runs/${run.id}`, pushedAt: new Date().toISOString() }), boxId)
}
const flow = (gitFlow: Partial<ProjectGitFlow>) => f.db.prepare('UPDATE projects SET factory_json=? WHERE id=?').run(JSON.stringify({ gitFlow: { ...DEFAULT_GIT_FLOW, ...gitFlow } }), 'proj')
const approval = (status: string, request: Record<string, unknown> = {}) => {
  const id = crypto.randomUUID()
  f.db.prepare("INSERT INTO factory_approvals(id,box_id,run_id,call_id,kind,request_json,digest,status,expires_at,created_at) VALUES(?,?,?,?,'publish',?,?,?,?,?)")
    .run(id, boxId, run.id, 'call-' + id, JSON.stringify({ sha, title: 'Add a level', body: 'A new level with sprites', ref: branch(), ...request }), 'digest', status, new Date(Date.now() + 600000).toISOString(), new Date().toISOString())
  return id
}
const outbound = (grant: Omit<BoxEgress, 'boxId' | 'lease'>) => new BoxOutbound({ props: { boxId, lease, ...grant }, waitUntil: () => {} } as never, f.env)
const pushBody = (...commands: string[]) => commands.map((command, index) => pktLine(index ? command + '\n' : command + '\0report-status agent=git/2.47\n')).join('') + '0000PACK-the-pack-itself'
const environmentRow = () => JSON.parse(String((f.db.prepare("SELECT config_json AS config FROM agent_environments WHERE id=(SELECT environment_id FROM project_repositories WHERE project_id='proj' AND provider='artifacts')").get() as { config: string }).config)) as Record<string, unknown>

beforeEach(async () => {
  f = mcpFixture()
  fake = fakeArtifacts()
  const now = new Date().toISOString()
  Object.assign(f.env, { PUBLIC_ORIGIN: 'https://server.example', FACTORY_CODE: fake.binding, FACTORY_IMAGE: image, FACTORY_COMPUTE: { idFromName: (name: string) => name, getByName: () => ({ wake: async () => {} }) }, CHANNEL_DO: { getByName: () => ({ fanout: async () => {} }) } })
  f.db.prepare('UPDATE roles SET permissions_bitmask=? WHERE id=?').run(ALL_PERMISSIONS, ids.agentRole)
  f.db.prepare('INSERT INTO task_boards(id,name,created_by) VALUES(?,?,?)').run('factory-board', 'Factory', ids.owner)
  f.db.prepare('INSERT INTO compute_nodes(id,name,token_hash,capabilities_json,last_seen,created_by,created_at) VALUES(?,?,?,?,?,?,?)').run(nodeId, 'Cloudflare', await factoryHash('node-token'), JSON.stringify(capabilities), now, ids.owner, now)
  f.db.prepare('INSERT INTO projects(id,name,description,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?)').run('proj', 'Afterprompt', 'A game', ids.owner, now, now)
  vi.stubGlobal('fetch', fake.network)
})
afterEach(() => { f.db.close(); vi.unstubAllGlobals() })

describe('where a repository in L4 exists', () => {
  it('is available only with the Server’s own Artifacts binding, on a Cloudflare-based or a hosted Server', async () => {
    expect(artifactsAvailability(f.env)).toEqual({ available: true, reason: null })
    expect(await gitAgentConfigured(f.env, null, 'artifacts')).toBe(true)
    f.env.LLLL_RUNTIME = 'celld'
    expect(artifactsAvailability(f.env)).toMatchObject({ available: false, reason: expect.stringContaining('own Cloudflare account') })
    // A hosted Server has its namespace from its installer; one installed before that says so.
    f.env.LLLL_RUNTIME = 'cloud'
    expect(artifactsAvailability(f.env)).toEqual({ available: true, reason: null })
    const binding = f.env.FACTORY_CODE
    delete f.env.FACTORY_CODE
    expect(artifactsAvailability(f.env)).toMatchObject({ available: false, reason: expect.stringContaining('next update') })
    await expect(createProjectRepository(f.env, await f.actor(), 'proj', {})).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('next update') })
    f.env.FACTORY_CODE = binding
    delete f.env.LLLL_RUNTIME; delete f.env.FACTORY_CODE
    expect(artifactsAvailability(f.env)).toMatchObject({ available: false, reason: expect.stringContaining('Enable Compute') })
    expect(await gitAgentConfigured(f.env, null, 'artifacts')).toBe(false)
    await expect(createProjectRepository(f.env, await f.actor(), 'proj', {})).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('Enable Compute') })
    expect(fake.binding.create).not.toHaveBeenCalled()
  })

  it('names a repository after its Project within Artifacts’ rules and never like a box’s checkpoint', () => {
    expect(projectRepositoryName('Afterprompt')).toBe('afterprompt')
    expect(projectRepositoryName('  Space Shooter: Déjà Vu! ')).toBe('space-shooter-deja-vu')
    expect(projectRepositoryName('***')).toBe('project')
    expect(projectRepositoryName('l4' + 'ab12'.repeat(10))).toBe('project-l4' + 'ab12'.repeat(10))
    expect(projectRepositoryName('x'.repeat(100), 12)).toHaveLength(63)
    expect(projectRepositoryName('x'.repeat(100), 12).endsWith('-12')).toBe(true)
    expect(projectRepositoryName('Afterprompt', 2)).toBe('afterprompt-2')
  })

  it('describes an environment in L4 by its name, id and remote, and never a GitHub one', () => {
    const inL4 = { provider: 'artifacts', name: 'Game', sourceRepo: 'game', sourceRepoId: 0, sourceInstallationId: 0, workRepo: 'game', workRepoId: 0, workInstallationId: 0, repositoryId: 'repo-1', remote: 'https://acc.artifacts.cloudflare.net/git/l4/game.git' }
    expect(codeEnvironmentSchema.safeParse(inL4).success).toBe(true)
    expect(repositoryResourceId(codeEnvironmentSchema.parse(inL4))).toBe('artifacts:game')
    for (const broken of [{ ...inL4, remote: undefined }, { ...inL4, repositoryId: undefined }, { ...inL4, sourceRepo: 'owner/game', workRepo: 'owner/game' }, { ...inL4, sourceRepoId: 11, workRepoId: 11 }, { ...inL4, gitConnectionId: '00000000-0000-4000-8000-000000000001' }, { ...inL4, remote: 'http://acc.artifacts.cloudflare.net/git/l4/game.git' }])
      expect(codeEnvironmentSchema.safeParse(broken).success).toBe(false)
    const github = { name: 'App', sourceRepo: 'inchidev/afterprompt', sourceRepoId: 11, sourceInstallationId: 101, workRepo: 'inchidev/afterprompt', workRepoId: 11, workInstallationId: 101 }
    expect(codeEnvironmentSchema.safeParse(github).success).toBe(true)
    expect(codeEnvironmentSchema.safeParse({ ...github, remote: 'https://acc.artifacts.cloudflare.net/git/l4/game.git' }).success).toBe(false)
    expect(codeEnvironmentSchema.safeParse({ ...github, sourceRepoId: 0, workRepoId: 0 }).success).toBe(false)
  })
})

describe('a repository created from a Project', () => {
  it('is made in the Server’s namespace with a first commit on main, its creation token revoked, and attached to the Project', async () => {
    const owner = await f.actor()
    const result = await createProjectRepository(f.env, owner, 'proj', {})
    expect(result.repository).toMatchObject({ provider: 'artifacts', slug: 'afterprompt', defaultBranch: 'main', host: 'https://acc.artifacts.cloudflare.net', externalId: expect.stringMatching(/^repo-/u) })
    expect(result.environment).toMatchObject({ provider: 'artifacts', sourceRepo: 'afterprompt', sourceRepoId: 0, remote: fake.remote('afterprompt'), computeNodeId: nodeId, baseBranch: 'main' })
    expect(fake.binding.create).toHaveBeenCalledWith('afterprompt', { description: 'L4 Project Afterprompt', setDefaultBranch: 'main' })
    const repo = fake.repos.get('afterprompt')!
    expect(fake.pushes).toHaveLength(1)
    const [push] = fake.pushes
    expect(push!.commands).toEqual([`${zero} ${repo.refs.get('refs/heads/main')} refs/heads/main\0report-status agent=l4`])
    expect(push!.objects.map(object => object.type).sort()).toEqual(['blob', 'commit', 'tree'])
    const first = repo.commits.get(repo.refs.get('refs/heads/main')!)!
    expect(first).toMatchObject({ parents: [], message: 'Create Afterprompt', author: { name: 'Owner', email: 'noreply@server.example' }, committer: { name: 'L4', email: 'noreply@server.example' } })
    expect(new TextDecoder().decode(repo.objects.get(first.treeHash)!.body)).toContain('README.md')
    // The creation token pushed the first commit and is gone; no token stays alive.
    expect(fake.liveTokens(repo)).toEqual([])
    expect(environmentRow()).toMatchObject({ provider: 'artifacts', repositoryId: repo.id, remote: repo.remote })
    expect(f.db.prepare("SELECT action FROM audit_log WHERE action='project.repository.create'").get()).toBeTruthy()
    // A second Project with the same name gets the next free name.
    const now = new Date().toISOString()
    f.db.prepare('INSERT INTO projects(id,name,created_by,created_at,updated_at) VALUES(?,?,?,?,?)').run('proj2', 'Afterprompt', ids.owner, now, now)
    expect((await createProjectRepository(f.env, owner, 'proj2', {})).repository.slug).toBe('afterprompt-2')
    // An explicit name must be free.
    f.db.prepare('INSERT INTO projects(id,name,created_by,created_at,updated_at) VALUES(?,?,?,?,?)').run('proj3', 'Third', ids.owner, now, now)
    await expect(createProjectRepository(f.env, owner, 'proj3', { name: 'afterprompt' })).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('exists already') })
    await expect(createProjectRepository(f.env, owner, 'proj3', { name: '../x' })).rejects.toMatchObject({ statusCode: 400 })
  })

  it('runs on L4 Compute on a hosted Server, with no computer to add', async () => {
    f.env.LLLL_RUNTIME = 'cloud'
    f.db.prepare('UPDATE compute_nodes SET enabled=0 WHERE id=?').run(nodeId)
    const result = await createProjectRepository(f.env, await f.actor(), 'proj', {})
    const placement = f.db.prepare("SELECT id FROM compute_nodes WHERE placement_id IS NULL AND json_extract(capabilities_json,'$.provider')='l4-compute'").get() as { id: string }
    expect(placement?.id).toBeTruthy()
    expect(result.environment).toMatchObject({ provider: 'artifacts', computeNodeId: placement.id })
  })

  it('needs the same authority as connecting a repository', async () => {
    await expect(createProjectRepository(f.env, await f.actor(ids.member), 'proj', {})).rejects.toMatchObject({ statusCode: 403 })
    expect(fake.binding.create).not.toHaveBeenCalled()
  })

  it('keeps nothing when the first commit cannot be pushed', async () => {
    fake.network.mockImplementationOnce(async (input: string | URL | Request) => String(input instanceof Request ? input.url : input).endsWith('/git-receive-pack') ? new Response('storage trouble', { status: 500 }) : new Response('x', { status: 404 }))
    await expect(createProjectRepository(f.env, await f.actor(), 'proj', {})).rejects.toMatchObject({ statusCode: 502, message: expect.stringContaining('Nothing was kept') })
    expect(fake.binding.delete).toHaveBeenCalledWith('afterprompt')
    expect(fake.repos.get('afterprompt')!.deleted).toBe(true)
    expect(f.db.prepare("SELECT count(*) AS n FROM project_repositories WHERE project_id='proj'").get()).toEqual({ n: 0 })
  })
})

describe('a Task on a repository in L4', () => {
  beforeEach(attachGame)

  it('tells the Agent there is no pull request and no CI, and that a person merges', async () => {
    const status = await factoryStatus(f.env, run.id)
    expect(status).toMatchObject({ gitProvider: 'artifacts', repository: 'game', branch: branch(), baseBranch: 'main' })
    expect(status.instruction).toContain('lives in L4')
    expect(status.instruction).toContain('never merge it yourself')
  })

  it('records a publication for review in L4 instead of opening a pull request', async () => {
    pushedBranch()
    const id = approval('publishing')
    expect(await publishedApproval(f.env, nodeId, id, { ok: true })).toEqual({ accepted: true })
    const receipt = JSON.parse(String((f.db.prepare('SELECT pull_json AS pull FROM factory_boxes WHERE id=?').get(boxId) as { pull: string }).pull))
    expect(receipt).toMatchObject({ number: 0, commit: sha, branch: branch(), url: `https://server.example/runs/${run.id}`, pushedAt: expect.any(String) })
    expect(f.db.prepare('SELECT factory_state AS state,pull_url AS url FROM tasks WHERE id=?').get('game-task')).toEqual({ state: 'published', url: `https://server.example/runs/${run.id}` })
    expect(f.db.prepare('SELECT status FROM factory_approvals WHERE id=?').get(id)).toEqual({ status: 'completed' })
    // A branch that is not at the approved commit leaves the publication uncertain.
    pushedBranch(moved)
    const again = approval('publishing', { sha: moved })
    fake.seed('game', { hash: moved, treeHash: tree, parents: [baseSha], message: 'x' }, { [`refs/heads/${branch()}`]: sha })
    await expect(publishedApproval(f.env, nodeId, again, { ok: true })).rejects.toMatchObject({ statusCode: 409 })
    expect(f.db.prepare('SELECT status FROM factory_approvals WHERE id=?').get(again)).toEqual({ status: 'uncertain' })
  })

  it('hands a VPS Node a push through this Server, which mints a token per request and allows one ref update', async () => {
    const id = approval('approved')
    const grant = await computePublish(f.env, nodeId, id)
    expect(grant).toMatchObject({ remote: `https://server.example/api/compute-agent/publish/${id}.git`, authorization: expect.stringMatching(/^Bearer [a-f0-9]{64}$/u), ref: `refs/heads/${branch()}`, sha })
    expect('token' in grant).toBe(false)
    const expected = { ref: `refs/heads/${branch()}`, sha }
    const push = (body: string) => artifactsTransport(f.env, environment, '/git-receive-pack', new Request(`${grant.remote}/git-receive-pack`, { method: 'POST', headers: { 'Content-Type': 'application/x-git-receive-pack-request' }, body }), { service: 'git-receive-pack', expected })
    for (const [body, reason] of [[pushBody(`${zero} ${sha} refs/heads/main`), 'Task’s own branch'], [pushBody(`${zero} ${moved} refs/heads/${branch()}`), 'approved commit'], [pushBody(`${zero} ${sha} refs/heads/${branch()}`, `${zero} ${sha} refs/heads/main`), 'one ref update']] as const) {
      const refused = await push(body)
      expect(refused.status, reason).toBe(403)
      expect(await refused.text()).toContain(reason)
    }
    expect(fake.network).not.toHaveBeenCalled()
    // The approved update goes through with a write token that is revoked right after.
    const body = Buffer.concat([Buffer.from(pktLine(`${zero} ${sha} refs/heads/${branch()}\0report-status\n`) + '0000'), Buffer.from(await pack([]))])
    const answer = await push(body.toString('latin1'))
    expect(answer.status).toBe(200)
    expect(fake.pushes.at(-1)).toMatchObject({ repo: 'game', token: expect.stringMatching(/^art_v1_write-/u), commands: [expect.stringContaining(`${zero} ${sha} refs/heads/${branch()}`)] })
    expect(fake.liveTokens(fake.repos.get('game')!)).toEqual([])
    // A read of the source goes the same way, with a read token.
    const read = await artifactsTransport(f.env, environment, '/info/refs', new Request(`https://server.example/api/compute-agent/source/${boxId}.git/info/refs?service=git-upload-pack`), { service: 'git-upload-pack' })
    expect(read.status).toBe(200)
    expect(await read.text()).toContain(`${baseSha} refs/heads/main`)
    expect(fake.liveTokens(fake.repos.get('game')!)).toEqual([])
    expect((await artifactsTransport(f.env, environment, '/git-receive-pack', new Request(`https://server.example/api/compute-agent/source/${boxId}.git/git-receive-pack`, { method: 'POST', body: 'x' }), { service: 'git-upload-pack' })).status).toBe(403)
  })

  it('lets a Cloudflare box reach only the Project’s repository, with the Server’s short token added on the way out', async () => {
    const recorder = vi.fn(async () => new Response('git answer'))
    vi.stubGlobal('fetch', recorder)
    const remote = fake.remote('game'), ref = `refs/heads/${branch()}`
    const push = outbound({ push: { remote, token: 'art_v1_short-write', ref, sha } })
    expect((await push.fetch(new Request(`${remote}/git-receive-pack`, { method: 'POST', headers: { 'Content-Type': 'application/x-git-receive-pack-request' }, body: pushBody(`${zero} ${sha} ${ref}`) }))).status).toBe(200)
    expect(((recorder.mock.calls[0] as unknown as [Request])[0]).headers.get('Authorization')).toBe('Bearer art_v1_short-write')
    for (const body of [pushBody(`${zero} ${sha} refs/heads/main`), pushBody(`${zero} ${moved} ${ref}`), pushBody(`${sha} ${zero} ${ref}`)]) {
      expect((await push.fetch(new Request(`${remote}/git-receive-pack`, { method: 'POST', body }))).status).toBe(403)
    }
    // Another repository of the namespace is not this box's, whatever the grant names.
    const other = outbound({ push: { remote: fake.remote('other-game'), token: 't', ref, sha } })
    expect((await other.fetch(new Request(`${fake.remote('other-game')}/git-receive-pack`, { method: 'POST', body: pushBody(`${zero} ${sha} ${ref}`) }))).status).toBe(403)
    const source = outbound({ source: { remote, token: 'art_v1_short-read' } })
    expect((await source.fetch(new Request(`${remote}/info/refs?service=git-upload-pack`))).status).toBe(200)
    expect(((recorder.mock.calls.at(-1) as unknown as [Request])[0]).headers.get('Authorization')).toBe('Bearer art_v1_short-read')
    expect((await source.fetch(new Request(`${remote}/git-receive-pack`, { method: 'POST', body: 'x' }))).status).toBe(403)
    expect((await outbound({ source: { remote: fake.remote('other-game'), token: 't' } }).fetch(new Request(`${fake.remote('other-game')}/info/refs?service=git-upload-pack`))).status).toBe(403)
    expect(recorder).toHaveBeenCalledTimes(2)
  })

  it('is merged by the Server itself, by squash, once a person who read the diff asks', async () => {
    pushedBranch(); withReceipt()
    const owner = await f.actor()
    const state = await taskMergeState(f.env, owner, 'game-task')
    expect(state).toMatchObject({ canMerge: true, ready: true, unchecked: true, reason: ARTIFACTS_NO_CHECKS_REASON, checksRegisterUntil: null, box: { provider: 'artifacts', branch: branch() } })
    await expect(personMerge(f.env, await f.actor(ids.member), 'game-task', { sha })).rejects.toMatchObject({ statusCode: 403 })
    const merged = await personMerge(f.env, owner, 'game-task', { sha })
    expect(merged.message).toBe(`Merged ${branch()} into main (squash).`)
    const repo = fake.repos.get('game')!, head = repo.refs.get('refs/heads/main')!
    expect(head).not.toBe(baseSha)
    const commit = repo.commits.get(head)!
    expect(commit).toMatchObject({ treeHash: tree, parents: [baseSha], message: 'Add a level\n\nA new level with sprites', author: { name: 'Agent', email: 'agent@example.test' }, committer: { name: 'L4', email: 'noreply@server.example' } })
    expect(fake.pushes.at(-1)).toMatchObject({ commands: [`${baseSha} ${head} refs/heads/main\0report-status agent=l4`], token: expect.stringMatching(/^art_v1_write-/u) })
    expect(fake.liveTokens(repo)).toEqual([])
    expect(f.db.prepare("SELECT status,request_json AS request FROM factory_approvals WHERE kind='merge'").get()).toMatchObject({ status: 'completed', request: expect.stringContaining('"method":"squash"') })
    expect(f.db.prepare('SELECT factory_state AS state FROM tasks WHERE id=?').get('game-task')).toEqual({ state: 'merged' })
    expect(JSON.parse(String((f.db.prepare('SELECT pull_json AS pull FROM factory_boxes WHERE id=?').get(boxId) as { pull: string }).pull))).toMatchObject({ merged: { sha: head, method: 'squash', by: 'person' } })
    await expect(personMerge(f.env, owner, 'game-task', { sha })).rejects.toMatchObject({ statusCode: 409 })
  })

  it.each(['merge', 'rebase'] as const)('merges with the Project’s %s method', async method => {
    pushedBranch(); withReceipt(); flow({ method })
    await personMerge(f.env, await f.actor(), 'game-task', { sha })
    const repo = fake.repos.get('game')!, head = repo.refs.get('refs/heads/main')!
    if (method === 'rebase') { expect(head).toBe(sha); expect(fake.pushes.at(-1)!.objects).toEqual([]) }
    else expect(repo.commits.get(head)).toMatchObject({ treeHash: tree, parents: [baseSha, sha], message: `Merge ${branch()} into main\n\nAdd a level` })
  })

  it('refuses a merge when main moved past the branch, when the branch moved, and never lets the Agent merge', async () => {
    pushedBranch(); withReceipt()
    const owner = await f.actor()
    fake.seed('game', { hash: moved, treeHash: tree, parents: [baseSha], message: 'Someone else' }, { 'refs/heads/main': moved })
    await expect(personMerge(f.env, owner, 'game-task', { sha })).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('bring main into its branch') })
    expect(fake.repos.get('game')!.refs.get('refs/heads/main')).toBe(moved)
    expect(f.db.prepare("SELECT status FROM factory_approvals WHERE kind='merge'").all()).toEqual([{ status: 'failed' }])
    expect(f.db.prepare('SELECT factory_state AS state FROM tasks WHERE id=?').get('game-task')).toEqual({ state: 'merge_failed' })
    // A branch that includes main's new head merges.
    const caught = '9'.repeat(40)
    fake.seed('game', { hash: caught, treeHash: tree, parents: [sha, moved], message: 'Merge main' }, { [`refs/heads/${branch()}`]: caught })
    withReceipt(caught)
    expect((await personMerge(f.env, owner, 'game-task', { sha: caught })).message).toContain('Merged')
    expect(fake.repos.get('game')!.commits.get(fake.repos.get('game')!.refs.get('refs/heads/main')!)).toMatchObject({ parents: [moved], treeHash: tree })
    // The Agent's merge is never offered in an L4 repository, even under the Git flow that allows it elsewhere.
    flow({ merge: 'agent_after_checks' })
    withReceipt(caught)
    f.db.prepare("UPDATE factory_boxes SET pull_json=json_remove(pull_json,'$.merged') WHERE id=?").run(boxId)
    await expect(executeRunTool(f.env, run.id, { callId: 'agent-merge', name: 'factory_merge', arguments: { sha: caught } }, () => {})).rejects.toMatchObject({ statusCode: 403, message: expect.stringContaining('lives in L4') })
  })
})

describe('versions of a repository in L4', () => {
  beforeEach(attachGame)

  it('are annotated tags on main, made by someone who may merge and recorded with the Project', async () => {
    const owner = await f.actor()
    expect(await listProjectReleases(f.env, owner, 'proj')).toEqual({ releases: [], repository: { name: 'game', baseBranch: 'main' }, canRelease: true })
    // A Member who reads the Project but may not approve Agent actions sees the versions and cannot make one.
    f.db.prepare('UPDATE roles SET permissions_bitmask=permissions_bitmask|? WHERE id=?').run(Permission.readProjects, ids.memberRole)
    expect((await listProjectReleases(f.env, await f.actor(ids.member), 'proj')).canRelease).toBe(false)
    await expect(createProjectRelease(f.env, await f.actor(ids.member), 'proj', { version: '1.0.0' })).rejects.toMatchObject({ statusCode: 403, message: expect.stringContaining('Approve agent actions') })
    await expect(createProjectRelease(f.env, owner, 'proj', { version: 'one' })).rejects.toMatchObject({ statusCode: 400 })
    const release = await createProjectRelease(f.env, owner, 'proj', { version: '1.0.0', message: 'First playable' })
    expect(release).toMatchObject({ projectId: 'proj', repository: 'game', tag: 'v1.0.0', version: '1.0.0', sha: baseSha, message: 'First playable', createdBy: ids.owner })
    const repo = fake.repos.get('game')!
    const tagId = repo.refs.get('refs/tags/v1.0.0')!
    expect(fake.pushes.at(-1)).toMatchObject({ commands: [`${zero} ${tagId} refs/tags/v1.0.0\0report-status agent=l4`], objects: [{ type: 'tag', id: tagId }] })
    expect(repo.objects.get(tagId)!.body.toString()).toContain(`object ${baseSha}\ntype commit\ntag v1.0.0\ntagger Owner <noreply@server.example>`)
    expect(repo.objects.get(tagId)!.body.toString()).toContain('\n\nFirst playable\n')
    expect(fake.liveTokens(repo)).toEqual([])
    expect((await listProjectReleases(f.env, owner, 'proj')).releases).toEqual([release])
    await expect(createProjectRelease(f.env, owner, 'proj', { version: '1.0.0' })).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('exists already') })
    // A tag the repository already holds is never moved, even without a record.
    repo.refs.set('refs/tags/v1.1.0', baseSha)
    await expect(createProjectRelease(f.env, owner, 'proj', { version: '1.1.0' })).rejects.toMatchObject({ statusCode: 409 })
    expect(fake.repos.get('game')!.refs.get('refs/tags/v1.1.0')).toBe(baseSha)
    for (const version of ['1.0.0', '0.2.0-beta.1', '10.20.30']) expect(projectReleaseSchema.safeParse({ version }).success, version).toBe(true)
    for (const version of ['v1.0.0', '1.0', '01.0.0', '1.0.0-', 'x']) expect(projectReleaseSchema.safeParse({ version }).success, version).toBe(false)
  })
})
