import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ids, mcpFixture } from '../helpers/outbound-mcp'
import { Permission } from '../../shared/permissions'
import { codeEnvironmentSchema } from '../../shared/code-environments'
import { connectGitea } from '../../server/utils/gitea'
import { createProject, listProjectRepositories } from '../../server/utils/project-service'
import { connectRepository, inspectRepository, repositoryConnectOptions } from '../../server/utils/repository-connect'
import { findCodeEnvironment } from '../../server/utils/code-environment-service'

const host = 'https://git.example.test', token = 'a'.repeat(40), sha = 'b'.repeat(40)
let f: ReturnType<typeof mcpFixture>, project: string, connection: string
const calls: string[] = []
beforeEach(async () => {
  f = mcpFixture()
  connection = (await connectGitea(f.env, await f.actor(), { host, token }, vi.fn(async (url: string | URL | Request) =>
    String(url).endsWith('/user') ? Response.json({ id: 7, login: 'l4-bot' }) : Response.json([])))).id
  project = (await createProject(f.env, await f.actor(), { name: 'App' })).id
  calls.length = 0
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
    const path = String(url).slice(`${host}/api/v1`.length)
    calls.push(path)
    if (path.startsWith('/user/repos')) return Response.json([{ id: 11, full_name: 'team/app', fork: false, archived: false, default_branch: 'trunk', permissions: { push: true } }])
    if (path === '/repos/team/app') return Response.json({ id: 11, full_name: 'team/app', archived: false, fork: false, parent: null })
    if (path === '/repos/team/app/git/commits/trunk') return Response.json({ sha, commit: { tree: { sha } } })
    if (path.startsWith('/repos/team/app/commits/trunk/status')) return Response.json({ statuses: [{ context: 'ci / test (push)' }, { context: 'ci / lint (push)' }] })
    return new Response(`unexpected ${path}`, { status: 500 })
  }))
})
afterEach(() => { f.db.close(); vi.unstubAllGlobals() })
const addComputer = (id: string, enabled = 1) => f.db.prepare("INSERT INTO compute_nodes(id,name,token_hash,capabilities_json,enabled,last_seen,created_by,created_at) VALUES(?,?,?,?,?,?,?,?)")
  .run(id, 'Computer ' + id.slice(0, 4), 'hash-' + id, '{"provider":"docker"}', enabled, '2026-10-30', ids.owner, '2026-10-30')

it('lists what the flow needs and suggests the checks CI already reports', async () => {
  addComputer('11111111-1111-4111-8111-111111111111')
  const options = await repositoryConnectOptions(f.env, await f.actor(), project)
  expect(options.connections).toEqual([expect.objectContaining({ id: connection, provider: 'gitea', host })])
  expect(options.compute.map(node => node.name)).toEqual(['Computer 1111'])
  expect(await inspectRepository(f.env, await f.actor(), project, connection, 11)).toEqual({ name: 'team/app', defaultBranch: 'trunk', checks: ['ci / lint (push)', 'ci / test (push)'] })
})

it('creates the configuration, picks the only computer and attaches it to the project in one step', async () => {
  const computer = '11111111-1111-4111-8111-111111111111'
  addComputer(computer)
  addComputer('22222222-2222-4222-8222-222222222222', 0)
  const result = await connectRepository(f.env, await f.actor(), project, { gitConnectionId: connection, repositoryId: 11 })
  expect(result.environment).toMatchObject({ provider: 'gitea', name: 'app', sourceRepo: 'team/app', workRepo: 'team/app', baseBranch: 'trunk', computeNodeId: computer, requiredChecks: [] })
  expect(await findCodeEnvironment(f.env, result.environment.id)).toMatchObject({ enabled: true })
  expect(await listProjectRepositories(f.env, await f.actor(), project)).toEqual([expect.objectContaining({ provider: 'gitea', host, slug: 'team/app', externalId: '11', defaultBranch: 'trunk', environmentId: result.environment.id })])
  expect(calls).toContain('/repos/team/app/git/commits/trunk')
  await expect(connectRepository(f.env, await f.actor(), project, { gitConnectionId: connection, repositoryId: 11 })).rejects.toMatchObject({ statusCode: 409 })
})

it('leaves the computer for the person to choose when there are several, and refuses a disabled one', async () => {
  addComputer('11111111-1111-4111-8111-111111111111')
  addComputer('33333333-3333-4333-8333-333333333333')
  addComputer('22222222-2222-4222-8222-222222222222', 0)
  await expect(connectRepository(f.env, await f.actor(), project, { gitConnectionId: connection, repositoryId: 11, computeNodeId: '22222222-2222-4222-8222-222222222222' })).rejects.toMatchObject({ statusCode: 400 })
  const result = await connectRepository(f.env, await f.actor(), project, { gitConnectionId: connection, repositoryId: 11, requiredChecks: ['ci / test (push)'] })
  expect(result.environment).toMatchObject({ computeNodeId: null, requiredChecks: ['ci / test (push)'] })
})

it('needs Server administration and project management, and an unreachable repository fails clearly', async () => {
  f.db.prepare('UPDATE roles SET permissions_bitmask=? WHERE id=?').run(Permission.useAgents | Permission.manageProjects, ids.memberRole)
  await expect(repositoryConnectOptions(f.env, await f.actor(ids.member), project)).rejects.toMatchObject({ statusCode: 403 })
  await expect(connectRepository(f.env, await f.actor(ids.member), project, { gitConnectionId: connection, repositoryId: 11 })).rejects.toMatchObject({ statusCode: 403 })
  await expect(connectRepository(f.env, await f.actor(), project, { gitConnectionId: connection, repositoryId: 99 })).rejects.toMatchObject({ statusCode: 404 })
  await expect(connectRepository(f.env, await f.actor(), project, { gitConnectionId: connection })).rejects.toMatchObject({ statusCode: 400 })
})

it('accepts a configuration without required checks', () => {
  const base = { name: 'App', provider: 'gitea', gitConnectionId: ids.server, sourceRepo: 'team/app', sourceRepoId: 11, sourceInstallationId: 0, workRepo: 'team/app', workRepoId: 11, workInstallationId: 0 }
  expect(codeEnvironmentSchema.parse(base).requiredChecks).toEqual([])
})
