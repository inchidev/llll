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
    expect(first.prompt).toMatch(/^This turn is a conversation only/u)
    // The Run posts only a notice in the discussion; the creator who asked reads the Agent's answer in its place.
    const run = row<{ id: string; agent_id: string; channel_id: string }>('SELECT id,agent_id,channel_id FROM agent_runs WHERE task_id=?', made.body.task.taskId)!
    sqlite.prepare("UPDATE agent_runs SET status='completed',result_text='Who plays: alone or with friends?' WHERE id=?").run(run.id)
    sqlite.prepare("INSERT INTO messages(id,channel_id,author_id,content,created_at) VALUES('m-notice',?,?,?,?)")
      .run(run.channel_id, run.agent_id, `Run completed. ${PRIVATE_RUN_SUMMARY}\n\n[Open private Run](/runs/${run.id})`, new Date().toISOString())
    const read = await post('tasks/get', { identity: owner, taskId: made.body.task.taskId })
    expect((read.body as { task: { messages: Array<{ author: string; text: string }> } }).task.messages.at(-1)).toMatchObject({ author: 'agent', text: 'Who plays: alone or with friends?' })
    // The creator says go: this turn has the repository, so the Agent works on its box.
    await post('tasks/message', { identity: owner, requestId: 'req-build', taskId: made.body.task.taskId, text: 'Build it.', build: true })
    await settle()
    const second = row<{ environment_json: string | null; prompt: string }>("SELECT environment_json,prompt FROM agent_runs WHERE task_id=? AND prompt='Build it.'", made.body.task.taskId)!
    expect(JSON.parse(second.environment_json!)).toMatchObject({ provider: 'artifacts' })
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

  it('gives the partner’s Agent a Task on the Project’s board with its repository, answers at once, then attaches its files and starts the Agent', async () => {
    const { body: { project } } = await createProject()
    const made = await createTask(project.projectId)
    expect(made.status).toBe(200)
    const task = made.body.task
    expect(task).toEqual({ taskId: expect.stringMatching(ID), projectId: project.projectId, title: 'Add a level', state: 'open', branch: null, messages: [], commits: [] })
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
    expect(state({ lastRun: 'failed' })).toBe('failed')
    expect(state({ lastRun: 'running', factoryState: 'l4_credit' })).toBe('failed')
    expect(state({ lastRun: 'running', factoryState: 'l4_unreachable' })).toBe('failed')
    expect(state({ lastError: 'No model' })).toBe('failed')
    expect(state({ lastRun: 'running', lastError: 'old' })).toBe('working')
    expect(state({ status: 'failed', lastRun: 'completed' })).toBe('failed')
    expect(state({ status: 'done', lastRun: 'failed' })).toBe('done')
  })
})
