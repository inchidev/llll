import { PRIVATE_RUN_SUMMARY } from '../../server/utils/agent-tool-security'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { d1 } from '../helpers/sqlite-d1'
import { fakeArtifacts, type FakeArtifacts } from '../helpers/artifacts'
import { INIT_SQL } from '../../server/utils/db'
import { cloudRelay } from '../../server/utils/cloud-relay'
import { partnerTaskState, pruneRelayRequests } from '../../server/utils/cloud-partner'
import type { L4Env } from '../../workers/env'

const SECRET = 'cloud-secret-'.repeat(3)
const SERVER = '3f2b8c1e-5d4a-4e6f-9a7b-1c2d3e4f5a6b'
const owner = { provider: 'afterprompt', subject: 'acct_42' }
const friend = { provider: 'afterprompt', subject: 'acct_7' }
const ID = /^[A-Za-z0-9_-]{1,64}$/u
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])

type Message = { id: string; author: string; name: string | null; text: string; createdAt: string }
/** An answer, read loosely: each test reads the part its action answers. */
type Answer = {
  ok?: true; error?: string; message: Message
  project: { projectId: string; title: string; repository: { url: string; defaultBranch: string }; releases: unknown[] }
  task: { taskId: string; projectId: string; title: string; state: string; branch: string | null; messages: Message[]; commits: unknown[] }
}

/** The files bucket as the Server reads it: put, a ranged get, head and delete. */
function fakeBucket() {
  const objects = new Map<string, Uint8Array>()
  const bucket = {
    async put(key: string, value: Uint8Array | ReadableStream<Uint8Array> | string) {
      objects.set(key, value instanceof Uint8Array ? value : new Uint8Array(await new Response(value).arrayBuffer()))
      return {}
    },
    async get(key: string, options?: { range?: { offset: number; length?: number } }) {
      const bytes = objects.get(key)
      if (!bytes) return null
      const part = options?.range ? bytes.subarray(options.range.offset, options.range.offset + (options.range.length ?? bytes.length)) : bytes
      return { size: bytes.length, arrayBuffer: async () => part.slice().buffer, body: new Response(part.slice()).body }
    },
    async head(key: string) { const bytes = objects.get(key); return bytes ? { key, size: bytes.length } : null },
    async delete(key: string | string[]) { for (const item of [key].flat()) objects.delete(item) },
  }
  return { objects, bucket: bucket as unknown as R2Bucket }
}

/**
 * The partner's game doors: a Server claimed from its seed, with the partner's Agent, an Artifacts namespace and
 * a files bucket. Every action names its Member by identity and acts as that Member.
 */
describe('the partner’s game doors', () => {
  let sqlite: DatabaseSync, e: L4Env, fake: FakeArtifacts, files: ReturnType<typeof fakeBucket>
  let background: Promise<unknown>[]
  const steer = vi.fn(async () => false)
  const seed = { owner: { identity: owner, name: 'Ivan', username: 'ivan' }, agent: { name: 'Claude', role: 'admin', instructions: 'Build the game.', version: 1 }, secrets: {}, env: {} }
  const post = (action: string, body?: unknown) => cloudRelay(new Request(`https://acme.llll.gg/.llll/cloud/${action}`, { method: 'POST', headers: { authorization: `Bearer ${SECRET}` }, body: body === undefined ? undefined : JSON.stringify(body) }),
    e, `/.llll/cloud/${action}`, async () => {}, promise => { background.push(promise) })
    .then(async response => ({ status: response!.status, body: await response!.json() as Answer }))
  const settle = async () => { while (background.length) await Promise.allSettled(background.splice(0)) }
  const row = <T>(sql: string, ...values: Array<string | number>) => sqlite.prepare(sql).get(...values) as T | undefined
  const rows = <T>(sql: string, ...values: Array<string | number>) => sqlite.prepare(sql).all(...values) as T[]
  const agentId = () => row<{ id: string }>("SELECT id FROM users WHERE kind='agent' AND display_name='Claude'")!.id
  const attachmentServer = vi.fn(async (url: string) => url.endsWith('/sprite.png') ? new Response(PNG, { headers: { 'content-length': String(PNG.length) } }) : new Response('gone', { status: 404 }))

  beforeEach(async () => {
    background = []
    sqlite = new DatabaseSync(':memory:'); sqlite.exec('PRAGMA foreign_keys=ON'); sqlite.exec(INIT_SQL)
    sqlite.prepare('INSERT INTO server_identity(singleton,id) VALUES(1,?)').run(SERVER)
    sqlite.prepare("INSERT INTO server_setup(singleton,username,token_hash,server_name,seed_json,created_at,updated_at) VALUES(1,'ivan','hash','Paper Planes',?,'2026-11-08','2026-11-08')").run(JSON.stringify(seed))
    fake = fakeArtifacts()
    files = fakeBucket()
    e = {
      LLLL_RUNTIME: 'cloud', CLOUD_SECRET: SECRET, DB: d1(sqlite), AUTH_SECRET: 'test-server-secret-with-32-characters', PUBLIC_ORIGIN: 'https://acme.llll.gg',
      FACTORY_CODE: fake.binding, FILES: files.bucket, AI: {}, AGENT_MODEL: '@cf/test',
      AGENT_RUN_DO: { getByName: () => ({ wake: async () => {}, steer }) },
      SERVER_DO: { getByName: () => ({ notifyMembersChanged: async () => {} }) },
      CHANNEL_DO: { getByName: () => ({ fanout: async () => {} }) },
    } as unknown as L4Env
    // On a Worker, the global fetch is the public-network guard; here it is the namespace and the partner's file host.
    vi.stubGlobal('navigator', { userAgent: 'Cloudflare-Workers' })
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input)
      return url.startsWith('https://files.afterprompt.games/') ? attachmentServer(url) : fake.network(input, init)
    }))
    expect((await post('claim-owner')).status).toBe(200)
  })
  afterEach(async () => { await settle(); vi.unstubAllGlobals(); steer.mockClear(); attachmentServer.mockClear(); sqlite.close() })

  const createProject = async (requestId = 'req-project-1', title = 'Paper Planes') => post('projects/create', { identity: owner, requestId, title })
  const createTask = async (projectId: string, extra: Record<string, unknown> = {}) => post('tasks/create', {
    identity: owner, requestId: 'req-task-1', projectId, title: 'Add a level', body: 'A level with clouds.', links: ['https://afterprompt.games/brief'],
    attachments: [{ url: 'https://files.afterprompt.games/signed/sprite.png', name: 'sprite.png', contentType: 'image/png', size: PNG.length }], ...extra,
  })

  it('refuses an identity that names no active person, and everything before the claim', async () => {
    const unknown = { provider: 'afterprompt', subject: 'nobody' }
    for (const [action, body] of [['projects/create', { requestId: 'r1', title: 'X' }], ['projects/get', { projectId: 'p1' }], ['tasks/create', { requestId: 'r1', projectId: 'p1', title: 'X', body: '', links: [], attachments: [] }],
      ['tasks/get', { taskId: 't1' }], ['tasks/message', { requestId: 'r1', taskId: 't1', text: 'Hi' }]] as const)
      expect(await post(action, { identity: unknown, ...body })).toEqual({ status: 404, body: { error: 'No Member has this identity' } })
    await post('members/upsert', { identity: friend, name: 'Petya' })
    await post('members/remove', { identity: friend })
    expect(await post('projects/get', { identity: friend, projectId: 'p1' })).toEqual({ status: 404, body: { error: 'No Member has this identity' } })
    // An Agent is not a person, whatever identity names it.
    sqlite.prepare("INSERT INTO member_identities(provider,subject,user_id,created_at) VALUES('afterprompt','bot',?,'2026-11-09')").run(agentId())
    expect((await post('tasks/get', { identity: { provider: 'afterprompt', subject: 'bot' }, taskId: 't1' })).status).toBe(404)
    expect(await post('projects/get', { identity: owner, projectId: 'not a valid id!' })).toEqual({ status: 400, body: { error: 'Invalid request: projectId' } })
    sqlite.exec('DELETE FROM server')
    expect((await post('projects/get', { identity: owner, projectId: 'p1' })).status).toBe(409)
  })

  it('makes a game Project with its repository in L4 on the L4 Compute placement, once per request', async () => {
    const made = await createProject()
    expect(made.status).toBe(200)
    const project = made.body.project
    expect(project).toEqual({ projectId: expect.stringMatching(ID), title: 'Paper Planes', repository: { url: fake.remote('paper-planes'), defaultBranch: 'main' }, releases: [] })
    const placement = row<{ id: string }>("SELECT id FROM compute_nodes WHERE json_extract(capabilities_json,'$.provider')='l4-compute' AND placement_id IS NULL")!
    const config = JSON.parse(row<{ config: string }>('SELECT e.config_json AS config FROM agent_environments e JOIN project_repositories r ON r.environment_id=e.id WHERE r.project_id=?', project.projectId)!.config)
    expect(config).toMatchObject({ provider: 'artifacts', computeNodeId: placement.id, sourceRepo: 'paper-planes', baseBranch: 'main' })
    expect(fake.repos.get('paper-planes')!.refs.get('refs/heads/main')).toMatch(/^[a-f0-9]{40}$/u)

    // The same request again answers the same Project and makes nothing.
    expect(await createProject()).toEqual(made)
    expect(row<{ n: number }>('SELECT count(*) AS n FROM projects')?.n).toBe(1)
    expect(fake.binding.create).toHaveBeenCalledOnce()
    const second = await createProject('req-project-2')
    expect(second.body.project.repository.url).toBe(fake.remote('paper-planes-2'))

    expect(await post('projects/get', { identity: owner, projectId: project.projectId })).toEqual({ status: 200, body: { ok: true, project } })
    expect(await post('projects/get', { identity: owner, projectId: 'missing' })).toEqual({ status: 404, body: { error: 'Project not found' } })
  })

  it('lets a friend the creator invited start a game: the Owner makes it, the friend gets Developer access to it alone', async () => {
    await post('members/upsert', { identity: friend, name: 'Petya' })
    const { body: { project: others } } = await createProject()
    const made = await post('projects/create', { identity: friend, requestId: 'req-friend', title: 'Mine' })
    expect(made.status).toBe(200)
    const project = made.body.project
    expect(project).toMatchObject({ title: 'Mine', repository: { url: expect.any(String), defaultBranch: 'main' } })
    const friendId = row<{ id: string }>("SELECT user_id AS id FROM member_identities WHERE subject=?", friend.subject)!.id
    const ownerId = row<{ id: string }>('SELECT owner_id AS id FROM server')!.id
    expect(row<{ created_by: string }>('SELECT created_by FROM projects WHERE id=?', project.projectId)!.created_by).toBe(ownerId)
    expect(row<{ policy_id: string; member_id: string }>('SELECT policy_id,member_id FROM grants WHERE project_id=?', project.projectId)).toEqual({ policy_id: 'project-policy-developer', member_id: friendId })
    expect(await post('projects/get', { identity: friend, projectId: project.projectId })).toMatchObject({ status: 200 })
    // Another game of the Owner's stays out of the friend's sight.
    expect(await post('projects/get', { identity: friend, projectId: others.projectId })).toEqual({ status: 404, body: { error: 'Project not found' } })
    // The friend gave the game its first Task.
    expect((await post('tasks/create', { identity: friend, requestId: 'req-friend-task', projectId: project.projectId, title: 'Start' })).status).toBe(200)
  })

  it('removes the Project again when its repository cannot be made', async () => {
    fake.binding.create.mockRejectedValueOnce(Object.assign(new Error('boom'), { code: 'INTERNAL_ERROR' }))
    expect(await createProject()).toMatchObject({ status: 502, body: { error: expect.stringContaining('could not be created') } })
    expect(row<{ n: number }>('SELECT count(*) AS n FROM projects')?.n).toBe(0)
    expect((await createProject()).status).toBe(200)
  })

  it('talks an idea through without a box first, and builds on the creator’s word', async () => {
    const { body: { project } } = await createProject()
    const made = await createTask(project.projectId, { build: false, attachments: [] })
    expect(made.status).toBe(200)
    await settle()
    const first = row<{ environment_json: string | null; prompt: string }>('SELECT environment_json,prompt FROM agent_runs WHERE task_id=?', made.body.task.taskId)!
    expect(first.environment_json).toBeNull()
    expect(first.prompt).toMatch(/^This turn is a conversation: the box/u)
    // The Run posts only a notice in the discussion; the creator who asked reads the Agent's answer in its place.
    const run = row<{ id: string; agent_id: string; channel_id: string }>('SELECT id,agent_id,channel_id FROM agent_runs WHERE task_id=?', made.body.task.taskId)!
    sqlite.prepare("UPDATE agent_runs SET status='completed',result_text='Who plays: alone or with friends?' WHERE id=?").run(run.id)
    sqlite.prepare("INSERT INTO messages(id,channel_id,author_id,content,created_at) VALUES('m-notice',?,?,?,?)")
      .run(run.channel_id, run.agent_id, `Run completed. ${PRIVATE_RUN_SUMMARY}\n\n[Open private Run](/runs/${run.id})`, new Date().toISOString())
    const read = await post('tasks/get', { identity: owner, taskId: made.body.task.taskId })
    expect((read.body as { task: { messages: Array<{ author: string; text: string }> } }).task.messages.at(-1)).toMatchObject({ author: 'agent', text: 'Who plays: alone or with friends?' })
    // A Run that failed shows its reason to the Member who started it.
    sqlite.prepare("UPDATE agent_runs SET status='failed',result_text=NULL,last_error='The Agent’s box refused this turn. Ask again.' WHERE id=?").run(run.id)
    const failed = await post('tasks/get', { identity: owner, taskId: made.body.task.taskId })
    expect((failed.body as { task: { messages: Array<{ text: string }> } }).task.messages.at(-1)!.text).toBe('The Agent stopped: The Agent’s box refused this turn. Ask again.')
    // A turn that ended with no words says so, rather than pointing at an empty private page.
    sqlite.prepare("UPDATE agent_runs SET status='completed',result_text=NULL,last_error=NULL WHERE id=?").run(run.id)
    const silent = await post('tasks/get', { identity: owner, taskId: made.body.task.taskId })
    expect((silent.body as { task: { messages: Array<{ text: string }> } }).task.messages.at(-1)!.text).toBe('The Agent finished this turn without a reply. Ask it to continue, or what it did.')
    sqlite.prepare("UPDATE agent_runs SET status='completed',result_text='Who plays: alone or with friends?',last_error=NULL WHERE id=?").run(run.id)
    // The creator says go: this turn has the repository, so the Agent works on its box.
    await post('tasks/message', { identity: owner, requestId: 'req-build', taskId: made.body.task.taskId, text: 'Build it.', build: true })
    await settle()
    const second = row<{ environment_json: string | null; prompt: string }>("SELECT environment_json,prompt FROM agent_runs WHERE task_id=? AND prompt='Build it.'", made.body.task.taskId)!
    expect(JSON.parse(second.environment_json!)).toMatchObject({ provider: 'artifacts' })
    // The build turn has another authority, so the talk's transcript is not restored; it is told the conversation instead.
    const { taskHistoryBrief } = await import('../../server/utils/agent-context')
    const build = row<{ id: string; task_id: string; initiated_by: string; agent_id: string }>("SELECT id,task_id,initiated_by,agent_id FROM agent_runs WHERE task_id=? AND prompt='Build it.'", made.body.task.taskId)!
    const brief = await taskHistoryBrief(e, { id: build.id, taskId: build.task_id, initiatedBy: build.initiated_by, agentId: build.agent_id })
    expect(brief).toContain('Member: This turn is a conversation: the box')
    expect(brief).toContain('You: Who plays: alone or with friends?')
    expect(brief).not.toContain('Build it.')
    // Someone else's turns on the Task are never told.
    expect(await taskHistoryBrief(e, { id: build.id, taskId: build.task_id, initiatedBy: 'someone-else', agentId: build.agent_id })).toBe('')
  })

  it('lets the Agent start the build itself when the creator asks for it in a talk turn', async () => {
    const { body: { project } } = await createProject('req-start-build')
    const made = await createTask(project.projectId, { build: false, attachments: [] })
    await settle()
    const talk = row<{ id: string }>('SELECT id FROM agent_runs WHERE task_id=?', made.body.task.taskId)!
    sqlite.prepare("UPDATE agent_runs SET status='running' WHERE id=?").run(talk.id)
    const { executeRunTool, toolsForRun } = await import('../../server/utils/agent-tools')
    const { findAgentRun, runAuthorization } = await import('../../server/utils/agent-run-service')
    const found = (await findAgentRun(e, talk.id))!
    // Offered at once, not behind discovery: the Agent must not tell the creator to press a button.
    const offered = (await toolsForRun(e, await runAuthorization(e, found), () => {}, found)).descriptors.find(tool => tool.name === 'start_build')
    expect(offered).toMatchObject({ deferred: false })
    const result = await executeRunTool(e, talk.id, { callId: 'build-1', name: 'start_build', arguments: { plan: 'A cocktail race, solo or with friends.' } }, promise => { background.push(promise) })
    expect(result).toMatchObject({ started: true })
    const build = row<{ environment_json: string | null; prompt: string }>("SELECT environment_json,prompt FROM agent_runs WHERE task_id=? AND id<>?", made.body.task.taskId, talk.id)!
    expect(JSON.parse(build.environment_json!)).toMatchObject({ provider: 'artifacts' })
    expect(build.prompt).toContain('A cocktail race, solo or with friends.')
  })

  it('lists the Server’s models, keeps a chosen model and effort on the Task’s conversation, and shows the Agent at work', async () => {
    const { saveAgentProvider } = await import('../../server/utils/agent-providers')
    await saveAgentProvider(e, 'openrouter', { kind: 'openrouter', enabled: true, webSearch: false, apiKey: 'sk-or-test-key', models: [{ id: 'anthropic/claude-sonnet-5.5', api: 'chat', tools: true }, { id: 'openai/gpt-5.2', api: 'chat', tools: true }] })
    const listed = await post('models/list', { identity: owner })
    expect(listed.status).toBe(200)
    expect((listed.body as { models: Array<{ id: string }> }).models.map(model => model.id)).toEqual(expect.arrayContaining(['l4:openrouter:anthropic/claude-sonnet-5.5', 'l4:openrouter:openai/gpt-5.2']))
    expect((listed.body as { efforts: string[] }).efforts).toEqual(['auto', 'low', 'medium', 'high'])
    const { body: { project } } = await createProject('req-models')
    const made = await createTask(project.projectId, { build: false, attachments: [], model: 'l4:openrouter:openai/gpt-5.2', effort: 'high' })
    expect(made.status).toBe(200)
    await settle()
    const channel = row<{ channel_id: string }>('SELECT channel_id FROM agent_runs WHERE task_id=?', made.body.task.taskId)!.channel_id
    expect(row<{ value: string }>('SELECT value FROM server_settings WHERE key=?', `agents.conversation.${channel}.model`)?.value).toBe('l4:openrouter:openai/gpt-5.2')
    expect(row<{ value: string }>('SELECT value FROM server_settings WHERE key=?', `agents.conversation.${channel}.effort`)?.value).toBe('high')
    expect((await post('tasks/message', { identity: owner, requestId: 'req-bad-model', taskId: made.body.task.taskId, text: 'Hi', model: 'l4:openrouter:nope' })).status).toBe(400)
    // While it works, the partner sees its steps.
    const run = row<{ id: string }>('SELECT id FROM agent_runs WHERE task_id=?', made.body.task.taskId)!
    sqlite.prepare("UPDATE agent_runs SET status='running' WHERE id=?").run(run.id)
    sqlite.prepare("INSERT INTO agent_run_events(run_id,sequence,event_json,created_at) VALUES(?,0,?,?)").run(run.id, JSON.stringify({ type: 'tool', name: 'generate_image', purpose: 'Draw the cover' }), new Date().toISOString())
    const read = await post('tasks/get', { identity: owner, taskId: made.body.task.taskId })
    expect((read.body as { task: { state: string; activity: unknown } }).task).toMatchObject({ state: 'working', activity: { build: false, steps: [{ name: 'generate_image', purpose: 'Draw the cover' }] } })
  })

  it('lists the game’s files and reads one, from its repository in L4', async () => {
    const { body: { project } } = await createProject()
    const root = await post('projects/files', { identity: owner, projectId: project.projectId })
    expect(root).toMatchObject({ status: 200, body: { ok: true, files: { ref: 'main', path: '', entries: [{ name: 'README.md', type: 'file' }] } } })
    const readme = await post('projects/file', { identity: owner, projectId: project.projectId, path: 'README.md' })
    expect(readme).toMatchObject({ status: 200, body: { ok: true, file: { ref: 'main', path: 'README.md', text: expect.stringContaining('# Paper Planes') } } })
    expect((await post('projects/file', { identity: owner, projectId: project.projectId, path: 'missing.txt' })).status).toBe(404)
    expect((await post('projects/files', { identity: owner, projectId: project.projectId, path: '../etc' })).status).toBe(400)
    expect((await post('projects/files', { identity: owner, projectId: 'missing' })).status).toBe(404)
  })

  it('starts a game’s repository from the partner’s kit: its files in their folders in the first commit', async () => {
    const files = [{ path: 'index.html', text: '<!doctype html><script type="module" src="src/main.js"></script>' }, { path: 'src/main.js', text: 'export {}\n' }, { path: 'src/net/room.js', text: '// room\n' }]
    const made = await post('projects/create', { identity: owner, requestId: 'req-kit', title: 'Arena', files })
    expect(made.status).toBe(200)
    const projectId = (made.body as { project: { projectId: string } }).project.projectId
    const root = await post('projects/files', { identity: owner, projectId })
    expect((root.body as { files: { entries: unknown[] } }).files.entries).toEqual([{ name: 'src', type: 'folder' }, { name: 'index.html', type: 'file' }, { name: 'README.md', type: 'file' }])
    expect(await post('projects/file', { identity: owner, projectId, path: 'src/net/room.js' })).toMatchObject({ status: 200, body: { file: { text: '// room\n' } } })
    for (const bad of [[{ path: '../x', text: '' }], [{ path: '.env', text: '' }], [{ path: 'a', text: '' }, { path: 'a/b', text: '' }], [{ path: 'x', text: 'a' }, { path: 'x', text: 'b' }]]) {
      expect((await post('projects/create', { identity: owner, requestId: `req-bad-${bad[0]!.path}${bad.length}`, title: 'Bad', files: bad })).status).toBe(400)
    }
  })

  it('gives a game Project the partner’s secret, bound to its host and open in the Project’s network, and tells the box', async () => {
    expect((await post('secrets/set', { secrets: { AFTERPROMPT_TOKEN: { value: 'apk_partner_publish_key', hosts: ['afterprompt.games'] } }, env: { AFTERPROMPT_URL: 'https://afterprompt.games' } })).status).toBe(200)
    const made = await post('projects/create', { identity: owner, requestId: 'req-partner-access', title: 'Arena' })
    const projectId = (made.body as { project: { projectId: string } }).project.projectId
    const secret = row<{ name: string; placeholder: string; hosts_json: string; secret_ciphertext: string }>('SELECT name,placeholder,hosts_json,secret_ciphertext FROM project_secrets WHERE project_id=?', projectId)!
    expect(secret).toMatchObject({ name: 'AFTERPROMPT_TOKEN', placeholder: 'L4_SECRET_AFTERPROMPT_TOKEN', hosts_json: '["afterprompt.games"]' })
    expect(secret.secret_ciphertext).not.toContain('apk_partner_publish_key')
    const network = JSON.parse(row<{ factory_json: string }>('SELECT factory_json FROM projects WHERE id=?', projectId)!.factory_json).network
    expect(network.hosts).toEqual(['afterprompt.games'])
    // The box's brief names the placeholder, the repository and the partner's settings, never the value.
    const { boxRunBrief } = await import('../../server/utils/box-egress')
    const brief = await boxRunBrief(e, { mandateJson: JSON.stringify({ projectId }), environmentJson: JSON.stringify({ remote: 'https://artifacts.example/arena.git' }) })
    expect(brief).toContain('AFTERPROMPT_TOKEN=L4_SECRET_AFTERPROMPT_TOKEN (put in for afterprompt.games)')
    expect(brief).toContain('https://artifacts.example/arena.git')
    expect(brief).toContain('AFTERPROMPT_URL=https://afterprompt.games')
    expect(brief).not.toContain('apk_partner_publish_key')
    // A new key from the partner reaches the Project at its next build; the placeholder stays.
    expect((await post('secrets/set', { secrets: { AFTERPROMPT_TOKEN: { value: 'apk_new_key', hosts: ['afterprompt.games'] } }, env: {} })).status).toBe(200)
    const { applyPartnerConfig } = await import('../../server/utils/cloud-seed')
    const before = row<{ secret_ciphertext: string }>('SELECT secret_ciphertext FROM project_secrets WHERE project_id=?', projectId)!.secret_ciphertext
    await applyPartnerConfig(e, projectId, row<{ id: string }>('SELECT owner_id AS id FROM server')!.id)
    expect(row<{ n: number }>('SELECT count(*) AS n FROM project_secrets WHERE project_id=?', projectId)!.n).toBe(1)
    expect(row<{ secret_ciphertext: string }>('SELECT secret_ciphertext FROM project_secrets WHERE project_id=?', projectId)!.secret_ciphertext).not.toBe(before)
  })

  it('gives the partner’s Agent a Task on the Project’s board with its repository, answers at once, then attaches its files and starts the Agent', async () => {
    const { body: { project } } = await createProject()
    const made = await createTask(project.projectId)
    expect(made.status).toBe(200)
    const task = made.body.task
    expect(task).toEqual({ activity: null, taskId: expect.stringMatching(ID), projectId: project.projectId, title: 'Add a level', state: 'open', branch: null, preview: false, requests: [], messages: [], commits: [] })
    const stored = row<{ board: string; assignee_id: string; environment_id: string; description: string; discussion_channel_id: string; status: string }>(
      'SELECT b.name AS board,t.assignee_id,t.environment_id,t.description,t.discussion_channel_id,t.status FROM tasks t JOIN task_boards b ON b.id=t.board_id WHERE t.id=?', task.taskId)!
    expect(stored).toMatchObject({ board: 'Tasks', assignee_id: agentId(), status: 'ready', discussion_channel_id: expect.any(String) })
    expect(stored.environment_id).toBe(row<{ id: string }>('SELECT environment_id AS id FROM project_repositories WHERE project_id=?', project.projectId)!.id)
    expect(stored.description).toBe('A level with clouds.\n\nLinks:\n- https://afterprompt.games/brief\n\nAttached files:\n- sprite.png')
    await settle()
    const attachment = row<{ filename: string; content_type: string; size_bytes: number; r2_key: string; uploader_id: string }>('SELECT filename,content_type,size_bytes,r2_key,uploader_id FROM task_attachments WHERE task_id=?', task.taskId)!
    expect(attachment).toMatchObject({ filename: 'sprite.png', content_type: 'image/png', size_bytes: PNG.length, uploader_id: row<{ owner_id: string }>('SELECT owner_id FROM server')!.owner_id })
    expect(files.objects.get(attachment.r2_key)).toEqual(PNG)
    const run = row<{ agent_id: string; channel_id: string; prompt: string; idempotency_key: string; status: string }>('SELECT agent_id,channel_id,prompt,idempotency_key,status FROM agent_runs WHERE task_id=?', task.taskId)!
    expect(run).toMatchObject({ agent_id: agentId(), channel_id: stored.discussion_channel_id, idempotency_key: 'cloud-relay:tasks/create:req-task-1', status: 'queued' })
    expect(run.prompt).toContain(`Add a level\n\n${stored.description}`)
    // The model sees the screenshot itself, not just its name.
    expect(run.prompt).toContain(`Attached images:\n[l4-image:${row<{ id: string }>('SELECT id FROM task_attachments WHERE task_id=?', task.taskId)!.id}]`)
    expect((await post('tasks/get', { identity: owner, taskId: task.taskId })).body.task).toMatchObject({ state: 'working' })

    // The same request again answers the first answer and makes nothing.
    expect(await createTask(project.projectId)).toEqual(made)
    await settle()
    expect(row<{ n: number }>('SELECT count(*) AS n FROM tasks')?.n).toBe(1)
    expect(row<{ n: number }>('SELECT count(*) AS n FROM agent_runs')?.n).toBe(1)
    expect(attachmentServer).toHaveBeenCalledOnce()
  })

  it('refuses an Agent nobody has, and a Project the Member cannot reach', async () => {
    const { body: { project } } = await createProject()
    expect(await createTask(project.projectId, { agent: { name: 'Nobody' } })).toEqual({ status: 409, body: { error: 'No active Agent is named Nobody' } })
    expect(await createTask('missing')).toEqual({ status: 404, body: { error: 'Project not found' } })
    await post('members/upsert', { identity: friend, name: 'Petya' })
    expect(await post('tasks/create', { identity: friend, requestId: 'r', projectId: project.projectId, title: 'Mine', body: '', links: [], attachments: [] })).toEqual({ status: 404, body: { error: 'Project not found' } })
    expect(row('SELECT 1 FROM tasks')).toBeUndefined()
  })

  it('marks the Task failed, with the reason in its messages, when its files or its Agent cannot be had', async () => {
    const { body: { project } } = await createProject()
    const made = await createTask(project.projectId, { attachments: [{ url: 'https://files.afterprompt.games/signed/missing.png', name: 'missing.png', contentType: 'image/png', size: 10 }] })
    await settle()
    const got = await post('tasks/get', { identity: owner, taskId: made.body.task.taskId })
    expect(got.body.task.state).toBe('failed')
    expect(got.body.task.messages).toEqual([{ id: `failed-${made.body.task.taskId}`, author: 'system', name: null, text: 'missing.png could not be fetched (HTTP 404)', createdAt: expect.any(String) }])
    expect(row<{ status: string }>('SELECT status FROM tasks WHERE id=?', made.body.task.taskId)?.status).toBe('failed')
    expect(row('SELECT 1 FROM agent_runs')).toBeUndefined()

    // No model to think with: the Run is refused, and the Task says why.
    delete (e as Partial<L4Env>).AI
    const second = await post('tasks/create', { identity: owner, requestId: 'req-task-2', projectId: project.projectId, title: 'Another', body: '', links: [], attachments: [] })
    await settle()
    const failed = await post('tasks/get', { identity: owner, taskId: second.body.task.taskId })
    expect(failed.body.task).toMatchObject({ state: 'failed', messages: [{ author: 'system', text: expect.stringContaining('Agent execution is unavailable') }] })
  })

  it('posts what the Member says in the Task’s discussion and starts the Agent on the Task with it, once per request', async () => {
    const { body: { project } } = await createProject()
    const { body: { task } } = await createTask(project.projectId, { attachments: [] })
    await settle()
    sqlite.prepare("UPDATE agent_runs SET status='completed' WHERE task_id=?").run(task.taskId)
    expect((await post('tasks/get', { identity: owner, taskId: task.taskId })).body.task.state).toBe('waiting')

    const said = await post('tasks/message', { identity: owner, requestId: 'req-msg-1', taskId: task.taskId, text: 'Make the clouds pink.' })
    expect(said).toEqual({ status: 200, body: { ok: true, message: { id: expect.stringMatching(ID), author: 'member', name: 'Ivan', text: 'Make the clouds pink.', createdAt: expect.any(String) } } })
    await settle()
    const run = row<{ prompt: string; source_message_id: string; status: string }>("SELECT prompt,source_message_id,status FROM agent_runs WHERE task_id=? AND source_message_id IS NOT NULL", task.taskId)!
    expect(run).toMatchObject({ source_message_id: said.body.message.id, status: 'queued' })
    expect(run.prompt).toContain('Make the clouds pink.')
    const got = (await post('tasks/get', { identity: owner, taskId: task.taskId })).body.task
    expect(got.state).toBe('working')
    expect(got.messages).toEqual([said.body.message])

    expect(await post('tasks/message', { identity: owner, requestId: 'req-msg-1', taskId: task.taskId, text: 'Make the clouds pink.' })).toEqual(said)
    await settle()
    expect(row<{ n: number }>('SELECT count(*) AS n FROM messages')?.n).toBe(1)
    expect(row<{ n: number }>('SELECT count(*) AS n FROM agent_runs')?.n).toBe(2)

    // A turn of the Agent's still running on the Task takes the words in instead of a new Run.
    sqlite.prepare("UPDATE agent_runs SET status='running' WHERE source_message_id=?").run(said.body.message.id)
    steer.mockResolvedValueOnce(true)
    await post('tasks/message', { identity: owner, requestId: 'req-msg-2', taskId: task.taskId, text: 'And bigger.' })
    await settle()
    expect(steer).toHaveBeenCalledWith(expect.any(String), 'And bigger.', row<{ owner_id: string }>('SELECT owner_id FROM server')!.owner_id)
    expect(row<{ n: number }>('SELECT count(*) AS n FROM agent_runs')?.n).toBe(2)
    expect(await post('tasks/message', { identity: owner, requestId: 'req-msg-3', taskId: 'missing', text: 'Hi' })).toEqual({ status: 404, body: { error: 'Task not found' } })
    // Longer than a chat message: the discussion gets it in parts, the Agent the whole text.
    const long = 'x'.repeat(2500)
    const before = row<{ n: number }>('SELECT count(*) AS n FROM messages')!.n
    sqlite.prepare("UPDATE agent_runs SET status='completed'").run()
    const answered = await post('tasks/message', { identity: owner, requestId: 'req-msg-4', taskId: task.taskId, text: long })
    expect(answered.body.message.text).toBe(long)
    await settle()
    expect(row<{ n: number }>('SELECT count(*) AS n FROM messages')!.n).toBe(before + 2)
    expect(row<{ prompt: string }>('SELECT prompt FROM agent_runs ORDER BY created_at DESC, rowid DESC LIMIT 1')!.prompt).toBe(long)
  })

  it('gives the Agent a screenshot sent with a message, on the Task and in the turn', async () => {
    const { body: { project } } = await createProject()
    const { body: { task } } = await createTask(project.projectId, { attachments: [] })
    await settle()
    sqlite.prepare("UPDATE agent_runs SET status='completed' WHERE task_id=?").run(task.taskId)
    const shot = { url: 'https://files.afterprompt.games/signed/sprite.png', name: 'shot.png', contentType: 'image/png', size: PNG.length }
    expect((await post('tasks/message', { identity: owner, requestId: 'req-shot', taskId: task.taskId, text: 'Ideas from this?', build: false, attachments: [shot] })).status).toBe(200)
    await settle()
    const file = row<{ id: string; filename: string }>("SELECT id,filename FROM task_attachments WHERE task_id=? AND filename='shot.png'", task.taskId)!
    expect(row<{ prompt: string }>('SELECT prompt FROM agent_runs WHERE source_message_id IS NOT NULL')!.prompt).toContain(`Ideas from this?\n\nAttached images:\n[l4-image:${file.id}]`)

    // A later turn still gets the Task's screenshot, not only its name.
    sqlite.prepare("UPDATE agent_runs SET status='completed' WHERE task_id=?").run(task.taskId)
    expect((await post('tasks/message', { identity: owner, requestId: 'req-later', taskId: task.taskId, text: 'And now?', build: false })).status).toBe(200)
    await settle()
    expect(row<{ prompt: string }>("SELECT prompt FROM agent_runs WHERE idempotency_key LIKE 'cloud-relay:%' ORDER BY created_at DESC,rowid DESC LIMIT 1")!.prompt).toContain(`And now?\n\nImages given with this Task earlier:\n[l4-image:${file.id}]`)
  })

  it('reopens a failed Task when the Member’s word starts its Agent', async () => {
    const { body: { project } } = await createProject()
    delete (e as Partial<L4Env>).AI
    const { body: { task } } = await createTask(project.projectId, { attachments: [] })
    await settle()
    expect((await post('tasks/get', { identity: owner, taskId: task.taskId })).body.task.state).toBe('failed')
    ;(e as { AI?: unknown }).AI = {}
    await post('tasks/message', { identity: owner, requestId: 'req-again', taskId: task.taskId, text: 'Try again.' })
    await settle()
    expect(row<{ status: string; last_error: string | null }>('SELECT status,last_error FROM tasks WHERE id=?', task.taskId)).toEqual({ status: 'ready', last_error: null })
    expect((await post('tasks/get', { identity: owner, taskId: task.taskId })).body.task.state).toBe('working')
  })

  it('reads the Task’s branch and its own commits from the Project’s repository, newest first', async () => {
    const { body: { project } } = await createProject()
    const { body: { task } } = await createTask(project.projectId, { attachments: [] })
    await settle()
    const run = row<{ id: string; channel_id: string; initiated_by: string }>('SELECT id,channel_id,initiated_by FROM agent_runs WHERE task_id=?', task.taskId)!
    const environment = row<{ id: string; config: string }>('SELECT e.id,e.config_json AS config FROM agent_environments e JOIN project_repositories r ON r.environment_id=e.id WHERE r.project_id=?', project.projectId)!
    const main = fake.repos.get('paper-planes')!.refs.get('refs/heads/main')!
    const node = row<{ id: string }>('SELECT id FROM compute_nodes LIMIT 1')!.id
    sqlite.prepare("INSERT INTO factory_boxes(id,channel_id,task_id,agent_id,initiated_by,node_id,environment_json,origin_run_id,status,created_at,updated_at) VALUES('box1',?,?,?,?,?,?,?,'running','2026-11-09','2026-11-09')")
      .run(run.channel_id, task.taskId, agentId(), run.initiated_by, node, JSON.stringify({ ...JSON.parse(environment.config), id: environment.id }), run.id)
    fake.seed('paper-planes', { hash: '1'.repeat(40), treeHash: '2'.repeat(40), parents: [main], message: 'Add clouds', committedAt: 1794200000 })
    fake.seed('paper-planes', { hash: '3'.repeat(40), treeHash: '4'.repeat(40), parents: ['1'.repeat(40)], message: 'Make them pink', committedAt: 1794200100 }, { 'refs/heads/l4-agent/box1': '3'.repeat(40) })
    const got = (await post('tasks/get', { identity: owner, taskId: task.taskId })).body.task
    expect(got.branch).toBe('l4-agent/box1')
    expect(got.commits).toEqual([
      { sha: '3'.repeat(40), message: 'Make them pink', branch: 'l4-agent/box1', createdAt: new Date(1794200100 * 1000).toISOString() },
      { sha: '1'.repeat(40), message: 'Add clouds', branch: 'l4-agent/box1', createdAt: new Date(1794200000 * 1000).toISOString() },
    ])
    // Without the binding the commits cannot be read, and the Task still answers.
    delete (e as Partial<L4Env>).FACTORY_CODE
    expect((await post('tasks/get', { identity: owner, taskId: task.taskId })).body.task).toMatchObject({ branch: 'l4-agent/box1', commits: [] })
    // A review waiting on the box is a question for the person.
    sqlite.prepare("INSERT INTO factory_approvals(id,box_id,run_id,call_id,kind,request_json,digest,status,expires_at,created_at) VALUES('a1','box1',?,'c1','publish','{}','d','pending_diff','2099-01-01','2026-11-09')").run(run.id)
    expect((await post('tasks/get', { identity: owner, taskId: task.taskId })).body.task.state).toBe('waiting')
  })

  it('hands the creator a short-lived link to watch the Task’s box while it runs with a viewer, and 404 otherwise', async () => {
    const { body: { project } } = await createProject()
    const { body: { task } } = await createTask(project.projectId, { attachments: [] })
    await settle()
    expect(await post('tasks/preview', { identity: owner, taskId: task.taskId })).toEqual({ status: 404, body: { error: 'The Task’s box is not running' } })
    expect((await post('tasks/get', { identity: owner, taskId: task.taskId })).body.task).toMatchObject({ preview: false })
    // The Task's box on its own L4 Compute Node, running under a live lease, with its viewer reported.
    const run = row<{ id: string; channel_id: string; initiated_by: string }>('SELECT id,channel_id,initiated_by FROM agent_runs WHERE task_id=?', task.taskId)!
    const placement = row<{ id: string }>("SELECT id FROM compute_nodes WHERE json_extract(capabilities_json,'$.provider')='l4-compute' AND placement_id IS NULL")!.id
    sqlite.prepare("INSERT INTO compute_nodes(id,name,token_hash,capabilities_json,created_by,created_at,placement_id,box_id) VALUES('boxnode','L4 Compute','h','{}',?,'2026-11-10',?,'box1')").run(run.initiated_by, placement)
    const environment = row<{ id: string; config: string }>('SELECT e.id,e.config_json AS config FROM agent_environments e JOIN project_repositories r ON r.environment_id=e.id WHERE r.project_id=?', project.projectId)!
    sqlite.prepare("INSERT INTO factory_boxes(id,channel_id,task_id,agent_id,initiated_by,node_id,environment_json,origin_run_id,status,lease_token,lease_until,cloud_box_id,preview,created_at,updated_at) VALUES('box1',?,?,?,?,'boxnode',?,?,'idle',?,?,'bx_9',1,'2026-11-10','2026-11-10')")
      .run(run.channel_id, task.taskId, agentId(), run.initiated_by, JSON.stringify({ ...JSON.parse(environment.config), id: environment.id }), run.id, 'e'.repeat(64), new Date(Date.now() + 60_000).toISOString())
    const asked: string[] = []
    const network = vi.mocked(fetch).getMockImplementation()!
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = String(input)
      if (!url.startsWith('https://llll.gg/')) return network(input, init)
      asked.push(`${init?.method} ${url} ${new Headers(init?.headers).get('authorization')}`)
      return Response.json({ url: 'https://sbx-6901.sandbox.us-east-1.onlizard.com/?lizard_token=t' })
    })
    expect((await post('tasks/get', { identity: owner, taskId: task.taskId })).body.task).toMatchObject({ preview: true })
    const watched = await post('tasks/preview', { identity: owner, taskId: task.taskId }) as unknown as { status: number; body: { ok: true; url: string; expiresAt: string } }
    expect(watched.status).toBe(200)
    expect(asked).toEqual([`POST https://llll.gg/api/compute/boxes/bx_9/preview Bearer l4h.${SERVER}.${SECRET}`])
    const url = new URL(watched.body.url)
    expect(url.searchParams.get('token')).toMatch(/^box1\.\d{13}\.[a-f0-9]{64}$/u)
    expect(Date.parse(watched.body.expiresAt) - Date.now()).toBeGreaterThan(29 * 60_000)
    // Another person, or a Task they cannot read, gets nothing.
    expect((await post('tasks/preview', { identity: friend, taskId: task.taskId })).status).toBe(404)
    expect((await post('tasks/preview', { identity: owner, taskId: 'missing' })).status).toBe(404)
    expect(asked).toHaveLength(1)
  })

  /** A Task whose Agent is at work on its box, in a running turn, with a request of each kind waiting for the creator. */
  async function waitingTask() {
    const { body: { project } } = await createProject()
    const { body: { task } } = await createTask(project.projectId, { attachments: [] })
    await settle()
    const run = row<{ id: string; channel_id: string; initiated_by: string; environment_json: string }>('SELECT id,channel_id,initiated_by,environment_json FROM agent_runs WHERE task_id=?', task.taskId)!
    const deadline = new Date(Date.now() + 30 * 60_000).toISOString()
    sqlite.prepare("UPDATE agent_runs SET status='running',deadline=? WHERE id=?").run(deadline, run.id)
    sqlite.prepare("INSERT INTO factory_boxes(id,channel_id,task_id,agent_id,initiated_by,node_id,environment_json,origin_run_id,status,created_at,updated_at) VALUES('box1',?,?,?,?,?,?,?,'running','2026-11-10','2026-11-10')")
      .run(run.channel_id, task.taskId, agentId(), run.initiated_by, JSON.parse(run.environment_json).computeNodeId, run.environment_json, run.id)
    const window = { id: '11111111-1111-4111-8111-111111111111', digest: 'a'.repeat(64) }
    const approve = (id: string, kind: string, request: unknown, digest: string, status: string, created: string) => sqlite.prepare('INSERT INTO factory_approvals(id,box_id,run_id,call_id,kind,request_json,digest,status,expires_at,created_at) VALUES(?,\'box1\',?,?,?,?,?,?,?,?)')
      .run(id, run.id, `call-${id}`, kind, JSON.stringify(request), digest, status, deadline, created)
    approve(window.id, 'window', { host: 'unpkg.com', minutes: 15, secrets: [], reason: 'Download three.module.js once and bundle it' }, window.digest, 'pending', '2026-11-10T10:00:00.000Z')
    approve('22222222-2222-4222-8222-222222222222', 'publish', { sha: 'f'.repeat(40), title: 'Add the tubes', body: 'Three tubes and a ball.', ref: 'l4-agent/box1' }, 'b'.repeat(64), 'pending_diff', '2026-11-10T10:01:00.000Z')
    return { task, run, window, deadline }
  }

  it('lists what the Agent waits on the creator for, in plain words with the digest to quote, and nothing of another person’s turn', async () => {
    const { task, run, window, deadline } = await waitingTask()
    const got = (await post('tasks/get', { identity: owner, taskId: task.taskId })).body.task as unknown as { state: string; requests: unknown[] }
    expect(got.state).toBe('waiting')
    expect(got.requests).toEqual([
      { id: window.id, kind: 'window', status: 'pending', digest: window.digest, createdAt: '2026-11-10T10:00:00.000Z', expiresAt: deadline, host: 'unpkg.com', minutes: 15, reason: 'Download three.module.js once and bundle it', secrets: [] },
      { id: '22222222-2222-4222-8222-222222222222', kind: 'publish', status: 'pending_diff', digest: 'b'.repeat(64), createdAt: '2026-11-10T10:01:00.000Z', expiresAt: deadline, title: 'Add the tubes', summary: 'Three tubes and a ball.', sha: 'f'.repeat(40), branch: 'l4-agent/box1' },
    ])
    // A turn someone else started is theirs to decide; a turn that ended asks nothing any more.
    sqlite.prepare("UPDATE agent_runs SET initiated_by=(SELECT id FROM users WHERE kind='agent' LIMIT 1) WHERE id=?").run(run.id)
    expect(((await post('tasks/get', { identity: owner, taskId: task.taskId })).body.task as unknown as { requests: unknown[] }).requests).toEqual([])
    sqlite.prepare("UPDATE agent_runs SET initiated_by=?,status='completed' WHERE id=?").run(run.initiated_by, run.id)
    expect(((await post('tasks/get', { identity: owner, taskId: task.taskId })).body.task as unknown as { requests: unknown[] }).requests).toEqual([])
  })

  it('lets the creator open a host for the Agent from the partner’s chat, as on the Run’s page, against the digest they saw', async () => {
    const { task, run, window } = await waitingTask()
    const decide = (extra: Record<string, unknown>) => post('tasks/decide', { identity: owner, taskId: task.taskId, approvalId: window.id, approve: true, digest: window.digest, ...extra }) as unknown as Promise<{ status: number; body: { error?: string; request?: Record<string, unknown> } }>
    expect(await decide({ approvalId: '33333333-3333-4333-8333-333333333333' })).toEqual({ status: 404, body: { error: 'This Task has no such request' } })
    expect(await decide({ digest: 'c'.repeat(64) })).toEqual({ status: 409, body: { error: 'Review the exact request again' } })
    expect(await decide({ approvalId: '22222222-2222-4222-8222-222222222222', digest: 'b'.repeat(64) })).toMatchObject({ status: 409 })
    // A request of another Task is not this Task's.
    expect((await post('tasks/decide', { identity: owner, taskId: 'other-task', approvalId: window.id, approve: true, digest: window.digest })).status).toBe(404)
    const opened = await decide({ requestId: 'req-decide-1' })
    expect(opened.status).toBe(200)
    expect(opened.body.request).toMatchObject({ id: window.id, kind: 'window', status: 'approved' })
    const stored = row<{ status: string; decided_by: string; result_json: string; expires_at: string }>('SELECT status,decided_by,result_json,expires_at FROM factory_approvals WHERE id=?', window.id)!
    expect(stored).toMatchObject({ status: 'approved', decided_by: run.initiated_by })
    expect(JSON.parse(stored.result_json)).toMatchObject({ open: true, host: 'unpkg.com' })
    // The same request ID answers the first answer; a new one is told it is decided already.
    expect(await decide({ requestId: 'req-decide-1' })).toEqual(opened)
    expect(await decide({})).toEqual({ status: 409, body: { error: 'This request was already decided' } })
    expect(((await post('tasks/get', { identity: owner, taskId: task.taskId })).body.task as unknown as { requests: Array<{ id: string }> }).requests.map(request => request.id)).toEqual(['22222222-2222-4222-8222-222222222222'])
  })

  it('refuses a decision from someone who cannot read the Task, and keeps a rejection as one', async () => {
    const { task, window } = await waitingTask()
    await post('members/upsert', { identity: friend, name: 'Petya' })
    // The friend cannot read the Task at all.
    expect((await post('tasks/decide', { identity: friend, taskId: task.taskId, approvalId: window.id, approve: true, digest: window.digest })).status).toBe(404)
    const rejected = await post('tasks/decide', { identity: owner, taskId: task.taskId, approvalId: window.id, approve: false, digest: window.digest }) as unknown as { status: number; body: { request: { status: string } } }
    expect(rejected).toMatchObject({ status: 200, body: { request: { status: 'rejected' } } })
  })

  it('tells L4 Cloud whether the Agents are working, so that an update waits for the turn to end', async () => {
    expect(await post('activity')).toEqual({ status: 200, body: { ok: true, running: 0, boxes: 0 } })
    const { run } = await waitingTask()
    // A running turn holding its box on L4 Compute.
    sqlite.prepare("UPDATE factory_boxes SET run_id=? WHERE id='box1'").run(run.id)
    expect(await post('activity')).toEqual({ status: 200, body: { ok: true, running: 1, boxes: 1 } })
    // A turn past its deadline is not work an update could cut short, and neither is the box it left.
    sqlite.prepare('UPDATE agent_runs SET deadline=? WHERE id=?').run(new Date(Date.now() - 1000).toISOString(), run.id)
    expect(await post('activity')).toEqual({ status: 200, body: { ok: true, running: 0, boxes: 0 } })
    // A box being started counts until it is up; a released one never does.
    sqlite.prepare("UPDATE factory_boxes SET status='starting' WHERE id='box1'").run()
    expect((await post('activity')).body).toMatchObject({ running: 0, boxes: 1 })
    sqlite.prepare("UPDATE factory_boxes SET status='released' WHERE id='box1'").run()
    sqlite.prepare("UPDATE agent_runs SET status='queued',deadline=? WHERE id=?").run(new Date(Date.now() + 60_000).toISOString(), run.id)
    expect((await post('activity')).body).toMatchObject({ running: 1, boxes: 0 })
  })

  it('says in plain words that the Agent waited for the creator’s answer when its turn ran out of time', async () => {
    const { task, run } = await waitingTask()
    const { unansweredRequest } = await import('../../server/utils/factory-approvals')
    // Still in time: nothing to say.
    expect(await unansweredRequest(e, { id: run.id, deadline: new Date(Date.now() + 60_000).toISOString() })).toBeNull()
    const past = new Date(Date.now() - 1000).toISOString()
    sqlite.prepare("UPDATE factory_approvals SET status='expired' WHERE kind='window'").run()
    const reason = await unansweredRequest(e, { id: run.id, deadline: past })
    expect(reason).toBe('The agent waited for your answer about publishing “Add the tubes” until its turn ran out of time, and stopped. Ask it to continue, and answer when it asks again.')
    sqlite.prepare("DELETE FROM factory_approvals WHERE kind='publish'").run()
    expect(await unansweredRequest(e, { id: run.id, deadline: past })).toBe('The agent waited for your answer about unpkg.com until its turn ran out of time, and stopped. Ask it to continue, and answer when it asks again.')
    // A window the creator opened was answered.
    sqlite.prepare("UPDATE factory_approvals SET decided_at='2026-11-10' WHERE kind='window'").run()
    expect(await unansweredRequest(e, { id: run.id, deadline: past })).toBeNull()
    sqlite.prepare("UPDATE factory_approvals SET decided_at=NULL WHERE kind='window'").run()
    // The Task's discussion says it as it is, not as a bare stop.
    sqlite.prepare("UPDATE agent_runs SET status='failed',last_error=? WHERE id=?").run((await unansweredRequest(e, { id: run.id, deadline: past }))!, run.id)
    const agent = row<{ agent_id: string }>('SELECT agent_id FROM agent_runs WHERE id=?', run.id)!.agent_id
    sqlite.prepare("INSERT INTO messages(id,channel_id,author_id,content,created_at) VALUES('m-notice',?,?,?,?)")
      .run(row<{ discussion_channel_id: string }>('SELECT discussion_channel_id FROM tasks WHERE id=?', task.taskId)!.discussion_channel_id, agent, `Run failed. ${PRIVATE_RUN_SUMMARY}\n\n[Open private Run](/runs/${run.id})`, new Date().toISOString())
    const messages = ((await post('tasks/get', { identity: owner, taskId: task.taskId })).body.task.messages)
    expect(messages.at(-1)!.text).toBe('The agent waited for your answer about unpkg.com until its turn ran out of time, and stopped. Ask it to continue, and answer when it asks again.')
  })

  it('opens the partner’s package hosts in its game Projects without a window, and keeps them when the secrets change', async () => {
    for (const hosts of [['*.npmjs.org'], ['127.0.0.1'], ['localhost'], ['cdn.local'], ['https://unpkg.com'], Array.from({ length: 21 }, (_, index) => `h${index}.example.com`)])
      expect((await post('hosts/set', { hosts })).status).toBe(400)
    expect(await post('hosts/set', { hosts: ['unpkg.com', 'cdn.jsdelivr.net', 'registry.npmjs.org', 'UNPKG.com'] })).toEqual({ status: 200, body: { ok: true, hosts: 3 } })
    // New secrets keep the hosts; the hosts never carry one.
    expect((await post('secrets/set', { secrets: { AFTERPROMPT_TOKEN: { value: 'apk_partner_publish_key', hosts: ['afterprompt.games'] } }, env: {} })).body).toMatchObject({ ok: true, secrets: 1, hosts: 3 })
    const made = await post('projects/create', { identity: owner, requestId: 'req-hosts', title: 'SuckTubes' })
    const projectId = made.body.project.projectId
    expect(JSON.parse(row<{ factory_json: string }>('SELECT factory_json FROM projects WHERE id=?', projectId)!.factory_json).network.hosts).toEqual(['unpkg.com', 'cdn.jsdelivr.net', 'registry.npmjs.org', 'afterprompt.games'])
    expect(row<{ n: number }>('SELECT count(*) AS n FROM project_secrets WHERE project_id=?', projectId)!.n).toBe(1)
    // The Agent is told which hosts it reaches without asking.
    const { boxRunBrief } = await import('../../server/utils/box-egress')
    expect(await boxRunBrief(e, { mandateJson: JSON.stringify({ projectId }), environmentJson: null })).toContain('Hosts this box reaches without asking, its Project\'s network: unpkg.com, cdn.jsdelivr.net, registry.npmjs.org, afterprompt.games.')
    // secrets/set with its own hosts replaces them; a later build adds what is new and closes nothing.
    expect((await post('secrets/set', { secrets: {}, env: {}, hosts: ['esm.sh'] })).body).toMatchObject({ hosts: 1 })
    const { applyPartnerConfig } = await import('../../server/utils/cloud-seed')
    await applyPartnerConfig(e, projectId, row<{ id: string }>('SELECT owner_id AS id FROM server')!.id)
    expect(JSON.parse(row<{ factory_json: string }>('SELECT factory_json FROM projects WHERE id=?', projectId)!.factory_json).network.hosts).toEqual(['unpkg.com', 'cdn.jsdelivr.net', 'registry.npmjs.org', 'afterprompt.games', 'esm.sh'])
  })

  it('forgets answers after a day, so the same request acts again', async () => {
    await createProject()
    sqlite.prepare('UPDATE cloud_relay_requests SET created_at=?').run(new Date(Date.now() - 2 * 86_400_000).toISOString())
    expect((await createProject()).body.project.repository.url).toBe(fake.remote('paper-planes-2'))
    sqlite.prepare('UPDATE cloud_relay_requests SET created_at=?').run(new Date(Date.now() - 2 * 86_400_000).toISOString())
    expect(await pruneRelayRequests(e)).toBe(1)
    expect(rows('SELECT * FROM cloud_relay_requests')).toEqual([])
  })
})

describe('a Task’s state for the partner', () => {
  const state = (input: Partial<Parameters<typeof partnerTaskState>[0]>) => partnerTaskState({ status: 'ready', factoryState: null, lastError: null, lastRun: null, reviewPending: false, ...input })
  it('maps L4’s Task, Run, box and review onto open, working, waiting, done and failed', () => {
    expect(state({})).toBe('open')
    expect(state({ lastRun: 'queued' })).toBe('working')
    expect(state({ lastRun: 'running' })).toBe('working')
    expect(state({ lastRun: 'running', reviewPending: true })).toBe('waiting')
    expect(state({ lastRun: 'completed' })).toBe('waiting')
    expect(state({ lastRun: 'cancelled' })).toBe('waiting')
    expect(state({ status: 'review', lastRun: 'completed' })).toBe('waiting')
    // A new turn on a Task an earlier turn left in review is working.
    expect(state({ status: 'review', lastRun: 'running' })).toBe('working')
    expect(state({ lastRun: 'failed' })).toBe('failed')
    expect(state({ lastRun: 'running', factoryState: 'l4_credit' })).toBe('failed')
    expect(state({ lastRun: 'running', factoryState: 'l4_unreachable' })).toBe('failed')
    expect(state({ lastError: 'No model' })).toBe('failed')
    expect(state({ lastRun: 'running', lastError: 'old' })).toBe('working')
    expect(state({ status: 'failed', lastRun: 'completed' })).toBe('failed')
    expect(state({ status: 'done', lastRun: 'failed' })).toBe('done')
  })
})
