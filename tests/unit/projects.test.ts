import { toRoleDto } from '../../server/utils/role-policy'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { ids, mcpFixture } from '../helpers/outbound-mcp'
import { Permission, ALL_PERMISSIONS } from '../../shared/permissions'
import { addProjectRepository, createProject, listProjects, requireProject, updateProject, listProjectRepositories, requireEnvironmentProject, removeProjectRepository } from '../../server/utils/project-service'
import { createTask, getTask, listTasks, updateTask } from '../../server/utils/task-service'
import { runAuthorization } from '../../server/utils/agent-run-service'
let f: ReturnType<typeof mcpFixture>
beforeEach(() => { f = mcpFixture(); Object.assign(f.env, { SERVER_DO: { getByName: () => ({ notifyTasksChanged: async () => {} }) } }); f.db.prepare('UPDATE roles SET permissions_bitmask=? WHERE id=?').run(ALL_PERMISSIONS, ids.memberRole) })
afterEach(() => f.db.close())
const create = async (name = 'Software factory') => createProject(f.env, await f.actor(), { name, description: 'Several repositories' })
const reference = (provider = 'github', externalId = '11') => ({ provider, externalId, host: 'https://github.com', slug: 'inchidev/afterprompt', defaultBranch: 'main' })
it('stores multiple provider-qualified repositories without granting credentials or Git execution', async () => {
 const p = await create(), owner = await f.actor()
 for (const provider of ['github', 'gitlab', 'gitea', 'cursor']) await addProjectRepository(f.env, owner, p.id, reference(provider))
 expect((await listProjectRepositories(f.env, owner, p.id)).map(r => r.provider)).toEqual(['github', 'gitlab', 'gitea', 'cursor'])
 expect((await listProjects(f.env, owner)).map(p => p.id)).toEqual([p.id])
 expect((await listProjectRepositories(f.env, owner, p.id)).every(r => r.environmentId === null)).toBe(true)
 await expect(addProjectRepository(f.env, owner, p.id, reference())).rejects.toMatchObject({ statusCode: 409 })
})
it('denies read/manage by default and restricts administration to human sessions', async () => {
 const p = await create()
 f.db.prepare('UPDATE roles SET permissions_bitmask=0 WHERE id=?').run(ids.memberRole)
 await expect(requireProject(f.env, await f.actor(ids.member), p.id)).rejects.toMatchObject({ statusCode: 403 })
 await expect(createProject(f.env, await f.actor(ids.member), { name: 'Denied' })).rejects.toMatchObject({ statusCode: 403 })
 f.db.prepare('UPDATE roles SET permissions_bitmask=? WHERE id=?').run(Permission.manageProjects, ids.agentRole)
 await expect(createProject(f.env, await f.actor(ids.agent), { name: 'Agent escalation' })).rejects.toMatchObject({ statusCode: 403 })
})
it('intersects Role resource scopes, delegation, and explicit project read permission', async () => {
 const a = await create('A'), b = await create('B')
 f.db.prepare('UPDATE roles SET resource_access_json=? WHERE id=?').run(JSON.stringify({ projects: [a.id] }), ids.memberRole)
 const member = await f.actor(ids.member)
 expect((await listProjects(f.env, member)).map(p => p.id)).toEqual([a.id])
 await expect(requireProject(f.env, member, b.id)).rejects.toMatchObject({ statusCode: 403 })
 await expect(addProjectRepository(f.env, member, b.id, reference())).rejects.toMatchObject({ statusCode: 403 })
 await expect(createProject(f.env, member, { name: 'Unscoped creation' })).rejects.toMatchObject({ statusCode: 403 })
 await expect(requireProject(f.env, { ...member, delegation: { by: ids.owner, permissions: 0 } }, a.id)).rejects.toMatchObject({ statusCode: 403 })
})
it('uses versioned project edits, archives without deleting records, and rejects stale saves', async () => {
 const p = await create(), owner = await f.actor()
 const archived = await updateProject(f.env, owner, p.id, { version: p.version, archived: true })
 expect(archived.archivedAt).toBeTruthy()
 await expect(updateProject(f.env, owner, p.id, { version: p.version, name: 'Stale' })).rejects.toMatchObject({ statusCode: 409 })
 await expect(addProjectRepository(f.env, owner, p.id, reference())).rejects.toMatchObject({ statusCode: 409 })
 expect((await updateProject(f.env, owner, p.id, { version: archived.version, archived: false })).archivedAt).toBeNull()
})
it('enforces project access on Git execution and revokes old snapshots on attach/detach', async () => {
 const p = await create(), owner = await f.actor()
 const config = { name: 'afterprompt', sourceRepo: 'inchidev/afterprompt', sourceRepoId: 11, sourceInstallationId: 1, workRepo: 'inchidev/afterprompt', workRepoId: 11, workInstallationId: 1, baseBranch: 'main', requiredChecks: ['test'], previewHosts: [] }
 f.db.prepare('INSERT INTO agent_environments(id,config_json,created_by,created_at,updated_at) VALUES(?,?,?,?,?)').run('execution', JSON.stringify(config), ids.owner, '2026-10-26', '2026-10-26')
 await expect(addProjectRepository(f.env, owner, p.id, { ...reference(), environmentId: 'execution', externalId: '22' })).rejects.toMatchObject({ statusCode: 400 })
 const ref = await addProjectRepository(f.env, owner, p.id, { ...reference(), environmentId: 'execution' })
 expect(f.db.prepare('SELECT version FROM agent_environments WHERE id=?').get('execution')!.version).toBe(2)
 f.db.prepare('UPDATE roles SET resource_access_json=? WHERE id=?').run('{"projects":[]}', ids.memberRole)
 await expect(requireEnvironmentProject(f.env, await f.actor(ids.member), 'execution')).rejects.toMatchObject({ statusCode: 403 })
 await updateProject(f.env, owner, p.id, { version: p.version, archived: true })
 await expect(requireEnvironmentProject(f.env, owner, 'execution')).rejects.toMatchObject({ statusCode: 403 })
 await removeProjectRepository(f.env, owner, p.id, ref.id)
 expect(f.db.prepare('SELECT version FROM agent_environments WHERE id=?').get('execution')!.version).toBe(3)
})
it('keeps Task bodies and collection results within project and board scopes', async () => {
 const p = await create(), owner = await f.actor()
 f.db.prepare('INSERT INTO task_boards(id,name,created_by) VALUES(?,?,?)').run('project-board', 'Board', ids.owner)
 const task = await createTask(f.env, owner, 'project-board', { projectId: p.id, title: 'Private project task', description: '', priority: 'normal', dueAt: null, assigneeId: null, channelId: null, labelIds: [], dependencyIds: [] }, () => {})
 expect(task.projectId).toBe(p.id)
 f.db.prepare('UPDATE roles SET resource_access_json=? WHERE id=?').run('{"projects":[]}', ids.memberRole)
 const member = await f.actor(ids.member)
 expect((await listTasks(f.env, member)).flatMap(b => b.tasks)).toHaveLength(0)
 await expect(getTask(f.env, member, task.id)).rejects.toMatchObject({ statusCode: 403 })
 await expect(updateTask(f.env, member, task.id, { title: 'Bypass' }, () => {})).rejects.toMatchObject({ statusCode: 403 })
 f.db.prepare('UPDATE roles SET permissions_bitmask=? WHERE id=?').run(ALL_PERMISSIONS, ids.agentRole)
 const { run } = await f.run()
 f.db.prepare('UPDATE agent_runs SET task_id=?,mandate_json=? WHERE id=?').run(task.id, JSON.stringify({ ...JSON.parse(run.mandateJson), projectId: p.id }), run.id)
 run.mandateJson = JSON.stringify({ ...JSON.parse(run.mandateJson), projectId: p.id })
 f.db.prepare('UPDATE roles SET permissions_bitmask=? WHERE id=?').run(ALL_PERMISSIONS, ids.agentRole)
 await runAuthorization(f.env, { ...run, taskId: task.id })
 await updateProject(f.env, owner, p.id, { version: p.version, archived: true })
 await expect(runAuthorization(f.env, { ...run, taskId: task.id })).rejects.toMatchObject({ statusCode: 403 })
})

it('does not expand an existing execution ceiling after later project grants', async () => {
 const p = await create(), owner = await f.actor()
 f.db.prepare('INSERT INTO task_boards(id,name,created_by) VALUES(?,?,?)').run('ceiling-board', 'Board', ids.owner)
 const task = await createTask(f.env, owner, 'ceiling-board', { projectId: p.id, title: 'Project work', description: '', priority: 'normal', dueAt: null, assigneeId: ids.agent, channelId: null, labelIds: [], dependencyIds: [] }, () => {})
 const { run } = await f.run()
 f.db.prepare('UPDATE agent_runs SET task_id=?,mandate_json=? WHERE id=?').run(task.id, JSON.stringify({ ...JSON.parse(run.mandateJson), projectId: p.id }), run.id)
 run.mandateJson = JSON.stringify({ ...JSON.parse(run.mandateJson), projectId: p.id })
 f.db.prepare('UPDATE roles SET permissions_bitmask=? WHERE id=?').run(ALL_PERMISSIONS, ids.agentRole)
 await expect(runAuthorization(f.env, { ...run, taskId: task.id })).rejects.toMatchObject({ statusCode: 403 })
})

it('reports current effective Owner grants without rewriting the stored Role mask', () => {
 const row = f.db.prepare('SELECT id,key,name,permissions_bitmask AS permissionsBitmask,resource_access_json AS resourceAccessJson,is_system AS isSystem,position,created_at AS createdAt,updated_at AS updatedAt FROM roles WHERE id=?').get(ids.ownerRole)!
 row.permissionsBitmask = 0
 const dto = toRoleDto(row as never, ids.server)
 expect(dto.permissions).toBe(ALL_PERMISSIONS)
 expect(dto.permissions & Permission.manageProjects).toBeTruthy()
})
