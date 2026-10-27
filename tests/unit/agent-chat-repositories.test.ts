import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ids, mcpFixture } from '../helpers/outbound-mcp'
import { MemberPermissions } from '../../shared/permissions'
import { createProject, addProjectRepository } from '../../server/utils/project-service'
import { assignProjectPolicy, revokeProjectPolicy } from '../../server/utils/project-policies'
import { inspectPrivateProjectRepository, inspectPublicProjectRepository, listPrivateProjectRepositories, listPublicProjectRepositories, readPrivateProjectFile } from '../../server/utils/agent-chat-repositories'
import type { AgentRun } from '../../shared/agent-execution'
const remote = vi.hoisted(() => ({ private: false }))
vi.mock('../../server/utils/github-agent-client', () => ({ githubAgentClient: async () => ({ json: async (path: string) => {
  if (path.endsWith('/git/trees/main')) return { tree: [{ path: 'README.md', type: 'blob' }] }
  if (path.includes('/contents/README.md')) return { encoding: 'base64', content: btoa('Public README'), size: 13 }
  return { id: 11, full_name: 'org/repo', private: remote.private, description: 'Public code', default_branch: 'main' }
} }) }))
let f: ReturnType<typeof mcpFixture>, run: AgentRun, repositoryId: string, projectId: string, assignmentId: string
beforeEach(async () => {
  remote.private = false
  f = mcpFixture()
  f.db.prepare('UPDATE roles SET permissions_bitmask=? WHERE id=?').run(MemberPermissions, ids.agentRole)
  const owner = await f.actor()
  projectId = (await createProject(f.env, owner, { name: 'Project' })).id
  assignmentId = (await assignProjectPolicy(f.env, owner, projectId, { policyId: 'project-policy-developer', memberId: ids.agent })).id
  const config = { name: 'Repo', sourceRepo: 'org/repo', sourceRepoId: 11, sourceInstallationId: 1, workRepo: 'org/repo', workRepoId: 11, workInstallationId: 1, baseBranch: 'main', requiredChecks: ['test'], previewHosts: [] }
  f.db.prepare('INSERT INTO agent_environments(id,config_json,created_by,created_at,updated_at) VALUES(?,?,?,?,?)').run('test-environment', JSON.stringify(config), ids.owner, new Date().toISOString(), new Date().toISOString())
  repositoryId = (await addProjectRepository(f.env, owner, projectId, { provider: 'github', host: 'https://github.com', slug: 'org/repo', externalId: '11', environmentId: 'test-environment' })).id
  run = (await f.run()).run
})
afterEach(() => f.db.close())
it('lists and reads the admitted public repository using the project grant', async () => {
  expect(await listPublicProjectRepositories(f.env, run)).toEqual({ repositories: [{ id: repositoryId, repository: 'org/repo' }] })
  expect(await inspectPublicProjectRepository(f.env, run, repositoryId)).toMatchObject({ repository: 'org/repo', readme: 'Public README', files: [{ path: 'README.md' }] })
})
it('reads private repositories with the same project grant without exposing them as public', async () => {
  remote.private = true
  expect(await listPublicProjectRepositories(f.env, run)).toEqual({ repositories: [] })
  await expect(inspectPublicProjectRepository(f.env, run, repositoryId)).rejects.toMatchObject({ statusCode: 403 })
  expect(await listPrivateProjectRepositories(f.env, run)).toEqual({ repositories: [{ id: repositoryId, repository: 'org/repo' }] })
  expect(await inspectPrivateProjectRepository(f.env, run, repositoryId)).toMatchObject({ repository: 'org/repo', readme: 'Public README' })
  expect(await readPrivateProjectFile(f.env, run, repositoryId, 'README.md')).toMatchObject({ content: 'Public README' })
  await expect(readPrivateProjectFile(f.env, run, repositoryId, '../secret')).rejects.toMatchObject({ statusCode: 400 })
})
it('rejects repositories added after admission', async () => {
  remote.private = true
  await expect(inspectPrivateProjectRepository(f.env, run, 'new-repository')).rejects.toMatchObject({ statusCode: 403 })
  await expect(inspectPublicProjectRepository(f.env, run, 'new-repository')).rejects.toMatchObject({ statusCode: 403 })
})
it('denies private repository access after project permission is revoked', async () => {
  remote.private = true
  await revokeProjectPolicy(f.env, await f.actor(), projectId, assignmentId)
  await expect(inspectPrivateProjectRepository(f.env, run, repositoryId)).rejects.toMatchObject({ statusCode: 403 })
  expect(await listPrivateProjectRepositories(f.env, run)).toEqual({ repositories: [] })
})
it('stops immediately after project access or repository configuration changes', async () => {
  f.db.prepare('UPDATE agent_environments SET version=version+1 WHERE id=?').run('test-environment')
  await expect(inspectPublicProjectRepository(f.env, run, repositoryId)).rejects.toMatchObject({ statusCode: 403 })
  await revokeProjectPolicy(f.env, await f.actor(), projectId, assignmentId)
  await expect(inspectPublicProjectRepository(f.env, run, repositoryId)).rejects.toMatchObject({ statusCode: 403 })
})
