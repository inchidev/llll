import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ids, mcpFixture } from '../helpers/outbound-mcp'
import { codeEnvironmentSchema, repositoryResourceId, type RunEnvironment } from '../../shared/code-environments'
import { giteaConnectSchema } from '../../shared/git-connections'
import { disableGitConnection, listGitConnections } from '../../server/utils/git-connections'
import { connectGitea, giteaAgentClient, giteaCredentials, giteaRepositories, giteaSourceFetch } from '../../server/utils/gitea'
import { discoverRepositories, gitAgentConfigured, repositoryClient } from '../../server/utils/git-provider'
import { publishGiteaProposal } from '../../server/utils/gitea-proposal'
import { computeSourceCapability } from '../../server/utils/compute-nodes'

const host = 'https://git.example.test', token = 'a'.repeat(40)
let f: ReturnType<typeof mcpFixture>
beforeEach(() => { f = mcpFixture() })
afterEach(() => { f.db.close(); vi.unstubAllGlobals() })
const account = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
  expect(new Headers(init?.headers).get('Authorization')).toBe(`token ${token}`)
  expect(init?.redirect).toBe('manual')
  if (String(url) === `${host}/api/v1/user`) return Response.json({ id: 7, login: 'l4-bot' })
  if (String(url) === `${host}/api/v1/user/repos?limit=1`) return Response.json([])
  return new Response('unexpected', { status: 500 })
})
const connect = async () => connectGitea(f.env, await f.actor(), { host, token }, account)

it('accepts only an HTTPS Gitea origin and a token-shaped secret', () => {
  expect(giteaConnectSchema.parse({ host: 'https://git.example.test/', token }).host).toBe(host)
  for (const bad of ['http://git.example.test', 'https://u:p@git.example.test', 'https://git.example.test/sub', 'https://git.example.test/?x=1', 'git.example.test'])
    expect(giteaConnectSchema.safeParse({ host: bad, token }).success, bad).toBe(false)
  expect(giteaConnectSchema.safeParse({ host, token: 'short' }).success).toBe(false)
})
it('connects an Owner-provided bot token, stores it encrypted and never returns it', async () => {
  await expect(connectGitea(f.env, await f.actor(ids.member), { host, token }, account)).rejects.toMatchObject({ statusCode: 403 })
  const connection = await connect()
  expect(connection).toMatchObject({ provider: 'gitea', host, account: 'l4-bot', appId: '7', enabled: true, setupUrl: `${host}/l4-bot`, name: 'l4-bot on git.example.test' })
  const stored = String(f.db.prepare('SELECT credential_json AS secret FROM git_connections WHERE id=?').get(connection.id)!.secret)
  expect(stored).not.toContain(token)
  expect(JSON.stringify(await listGitConnections(f.env))).not.toContain(token)
  expect(JSON.stringify(f.db.prepare('SELECT meta_json FROM audit_log').all())).not.toContain(token)
  expect(await giteaCredentials(f.env, connection.id)).toEqual({ host, account: 'l4-bot', token })
  await expect(connect()).rejects.toMatchObject({ statusCode: 409 })
})
it('refuses a token Gitea rejects or one that cannot list repositories', async () => {
  await expect(connectGitea(f.env, await f.actor(), { host, token }, vi.fn(async () => new Response('', { status: 401 })))).rejects.toMatchObject({ statusCode: 400 })
  await expect(connectGitea(f.env, await f.actor(), { host, token }, vi.fn(async (url: string | URL | Request) => String(url).endsWith('/user') ? Response.json({ id: 7, login: 'l4-bot' }) : new Response('', { status: 403 })))).rejects.toMatchObject({ statusCode: 400 })
  await expect(connectGitea(f.env, await f.actor(), { host, token }, vi.fn(async () => new Response(null, { status: 302, headers: { Location: 'https://elsewhere.test' } })))).rejects.toMatchObject({ statusCode: 502 })
  expect(await listGitConnections(f.env)).toEqual([])
})
it('discovers only pushable, active repositories with Gitea-scoped resource IDs', async () => {
  const connection = await connect()
  const remote = vi.fn(async (url: string | URL | Request) => {
    expect(String(url)).toBe(`${host}/api/v1/user/repos?limit=50&page=1`)
    return Response.json([
      { id: 11, full_name: 'team/app', fork: false, archived: false, default_branch: 'main', permissions: { push: true } },
      { id: 12, full_name: 'team/old', fork: false, archived: true, default_branch: 'main', permissions: { push: true } },
      { id: 13, full_name: 'team/read', fork: false, archived: false, default_branch: 'main', permissions: { push: false } },
    ])
  })
  expect(await giteaRepositories(f.env, connection.id, remote)).toEqual([{ id: 11, name: 'team/app', installationId: 0, fork: false, defaultBranch: 'main', resourceId: `gitea:${connection.id}:11` }])
  expect(await discoverRepositories(f.env, connection.id, remote)).toHaveLength(1)
  expect(await gitAgentConfigured(f.env, connection.id)).toBe(true)
  await disableGitConnection(f.env, await f.actor(), connection.id)
  expect(await gitAgentConfigured(f.env, connection.id)).toBe(false)
  await expect(giteaCredentials(f.env, connection.id)).rejects.toMatchObject({ statusCode: 403 })
})
it('keeps Gitea repository scopes apart from GitHub repository IDs', () => {
  const base = { name: 'App', sourceRepo: 'team/app', sourceRepoId: 11, workRepo: 'team/app', workRepoId: 11, baseBranch: 'main', requiredChecks: ['ci'] }
  const gitea = codeEnvironmentSchema.parse({ ...base, provider: 'gitea', gitConnectionId: ids.server, sourceInstallationId: 0, workInstallationId: 0 })
  expect(repositoryResourceId(gitea)).toBe(`gitea:${ids.server}:11`)
  expect(repositoryResourceId(codeEnvironmentSchema.parse({ ...base, sourceInstallationId: 5, workInstallationId: 5 }))).toBe('11')
  expect(codeEnvironmentSchema.safeParse({ ...base, provider: 'gitea', gitConnectionId: null, sourceInstallationId: 0, workInstallationId: 0 }).success).toBe(false)
  expect(codeEnvironmentSchema.safeParse({ ...base, sourceInstallationId: 0, workInstallationId: 0 }).success).toBe(false)
})
it('confines the broker to one repository and its operation class', async () => {
  const connection = await connect()
  const remote = vi.fn(async () => Response.json({}))
  const reader = await giteaAgentClient(f.env, { connectionId: connection.id, repository: 'team/app', access: 'read' }, undefined, remote)
  await reader.json('/repos/team/app/contents/README.md?ref=main')
  await expect(reader.raw('/repos/team/other')).rejects.toThrow('Invalid broker path')
  await expect(reader.raw('/repos/team/app-evil')).rejects.toThrow('Invalid broker path')
  await expect(reader.raw('/repos/team/app/../other')).rejects.toThrow('Invalid broker path')
  await expect(reader.raw('/repos/team/app/contents', 'POST', {})).rejects.toThrow('outside this repository capability')
  const writer = await giteaAgentClient(f.env, { connectionId: connection.id, repository: 'team/app', access: 'work' }, undefined, remote)
  await writer.json('/repos/team/app/contents', 'POST', {})
  await expect(writer.raw('/repos/team/app/pulls', 'POST', {})).rejects.toThrow('outside this repository capability')
  await expect(writer.raw('/repos/team/app', 'DELETE')).rejects.toThrow('outside this repository capability')
  expect(remote).toHaveBeenCalledTimes(2)
})
it('serves Git source read-only and never follows a redirect', async () => {
  const connection = await connect()
  const upstream = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    expect(new Headers(init?.headers).get('Authorization')).toBe('Basic ' + btoa(`l4-bot:${token}`))
    return String(url).includes('redirect') ? new Response(null, { status: 302, headers: { Location: 'https://elsewhere.test' } }) : new Response('refs', { headers: { 'content-type': 'application/x-git-upload-pack-advertisement' } })
  })
  vi.stubGlobal('fetch', upstream)
  const refs = await giteaSourceFetch(f.env, connection.id, 'team/app', '/info/refs', new Request('https://server.test/x/info/refs?service=git-upload-pack'))
  expect(await refs.text()).toBe('refs')
  expect(String(upstream.mock.calls[0]![0])).toBe(`${host}/team/app.git/info/refs?service=git-upload-pack`)
  expect((await giteaSourceFetch(f.env, connection.id, 'team/app', '/info/refs', new Request('https://server.test/x/info/refs?service=git-receive-pack'))).status).toBe(403)
  expect((await giteaSourceFetch(f.env, connection.id, 'team/app', '/git-receive-pack', new Request('https://server.test/x/git-receive-pack', { method: 'POST', body: 'x' }))).status).toBe(403)
  expect((await giteaSourceFetch(f.env, connection.id, 'team/redirect', '/info/refs', new Request('https://server.test/x/info/refs?service=git-upload-pack'))).status).toBe(502)
  expect(upstream).toHaveBeenCalledTimes(2)
})
it('binds the Node source capability to one action and lease', async () => {
  const first = await computeSourceCapability(f.env, ids.owner, 'lease-a')
  expect(first).toMatch(/^[a-f0-9]{64}$/u)
  expect(await computeSourceCapability(f.env, ids.owner, 'lease-a')).toBe(first)
  expect(await computeSourceCapability(f.env, ids.owner, 'lease-b')).not.toBe(first)
  expect(await computeSourceCapability(f.env, ids.member, 'lease-a')).not.toBe(first)
})
it('publishes a proposal on a Run branch started at the admitted base and opens a WIP pull request', async () => {
  const connection = await connect()
  const base = 'b'.repeat(40), commit = 'c'.repeat(40)
  const item = { ...codeEnvironmentSchema.parse({ provider: 'gitea', gitConnectionId: connection.id, name: 'App', sourceRepo: 'team/app', sourceRepoId: 11, sourceInstallationId: 0, workRepo: 'team/app', workRepoId: 11, workInstallationId: 0, baseBranch: 'main', requiredChecks: ['ci'] }),
    id: ids.server, enabled: true, version: 1, baseSha: base, baseTreeSha: 'd'.repeat(40) } satisfies RunEnvironment
  let branch: string | null = null
  const calls: string[] = []
  const pull = { number: 5, state: 'open', merged: false, title: 'WIP: Fix', body: 'Body', head: { ref: 'l4-agent/run', sha: commit, repo: { id: 11 } }, base: { ref: 'main', repo: { id: 11 } } }
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url).slice(`${host}/api/v1`.length), method = init?.method ?? 'GET'
    calls.push(`${method} ${path}`)
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    if (path === '/repos/team/app/git/refs/heads/l4-agent/run') return branch ? Response.json([{ ref: 'refs/heads/l4-agent/run-old', object: { sha: 'e'.repeat(40) } }, { ref: 'refs/heads/l4-agent/run', object: { sha: branch } }]) : new Response('', { status: 404 })
    if (path === '/repos/team/app/branches' && method === 'POST') { expect(body).toEqual({ new_branch_name: 'l4-agent/run', old_ref_name: base }); branch = base; return Response.json({}) }
    if (path.startsWith('/repos/team/app/contents/README.md')) return Response.json({ type: 'file', sha: 'f'.repeat(40) })
    if (path.startsWith('/repos/team/app/contents/new.txt')) return new Response('', { status: 404 })
    if (path === '/repos/team/app/contents' && method === 'POST') {
      expect(body.branch).toBe('l4-agent/run')
      expect(body.files).toEqual([{ operation: 'update', path: 'README.md', content: Buffer.from('Привет').toString('base64'), sha: 'f'.repeat(40) }, { operation: 'create', path: 'new.txt', content: btoa('new') }])
      branch = commit
      return Response.json({ commit: { sha: commit, parents: [{ sha: base }] } })
    }
    if (path.startsWith('/repos/team/app/pulls?state=all')) return Response.json([])
    if (path === '/repos/team/app/pulls' && method === 'POST') { expect(body).toMatchObject({ title: 'WIP: Fix', head: 'l4-agent/run', base: 'main' }); return Response.json(pull) }
    return new Response(`unexpected ${method} ${path}`, { status: 500 })
  }))
  const recorded: string[] = []
  const result = await publishGiteaProposal(f.env, { runId: 'run', environment: item, input: { title: 'Fix', body: '', files: [{ path: 'README.md', content: 'Привет', executable: false }, { path: 'new.txt', content: 'new', executable: false }] },
    description: 'Body', branch: 'l4-agent/run', proposal: { commitSha: null, publishedCommitSha: null, pullNumber: null }, ensure: async () => {}, recordCommit: async sha => { recorded.push(sha) } })
  expect(result).toEqual({ number: 5, url: `${host}/team/app/pulls/5`, commit })
  expect(recorded).toEqual([commit])
  expect(calls).not.toContain('PATCH /repos/team/app/pulls/5')
  await expect(publishGiteaProposal(f.env, { runId: 'run', environment: item, input: { title: 'Fix', body: '', files: [{ path: 'run.sh', content: 'echo', executable: true }] },
    description: 'Body', branch: 'l4-agent/run', proposal: { commitSha: null, publishedCommitSha: commit, pullNumber: null }, ensure: async () => {}, recordCommit: async () => {} })).rejects.toMatchObject({ statusCode: 400 })
  // A branch moved outside the Run is never written over.
  branch = 'e'.repeat(40)
  await expect(publishGiteaProposal(f.env, { runId: 'run', environment: item, input: { title: 'Fix', body: '', files: [{ path: 'new.txt', content: 'again', executable: false }] },
    description: 'Body', branch: 'l4-agent/run', proposal: { commitSha: null, publishedCommitSha: commit, pullNumber: null }, ensure: async () => {}, recordCommit: async () => {} })).rejects.toMatchObject({ statusCode: 409 })
  const client = await repositoryClient(f.env, item, 'source', 'read')
  expect(client.web('/pulls/5')).toBe(`${host}/team/app/pulls/5`)
})
