import { afterEach, beforeEach, expect, it } from 'vitest'
import { ids, mcpFixture } from '../helpers/outbound-mcp'
import { Permission, MemberPermissions } from '../../shared/permissions'
import { authorize, ServerAction } from '../../shared/authorization'
import { projectPermissionAllowed, ProjectPolicyPermissions } from '../../shared/project-access'
import { createProject, listProjects } from '../../server/utils/project-service'
import { assignProjectPolicy, revokeProjectPolicy, replaceProjectPolicy, listProjectPolicies, saveProjectPolicy } from '../../server/utils/project-policies'
import { createTask, getTask, listTasks, updateTask } from '../../server/utils/task-service'
import { runAuthorization } from '../../server/utils/agent-run-service'

let f: ReturnType<typeof mcpFixture>, a: string, b: string
beforeEach(async () => {
  f = mcpFixture()
  Object.assign(f.env, { SERVER_DO: { getByName: () => ({ notifyTasksChanged: async () => {} }) } })
  f.db.prepare('UPDATE roles SET permissions_bitmask=? WHERE id IN (?,?)').run(MemberPermissions, ids.memberRole, ids.agentRole)
  a = (await createProject(f.env, await f.actor(), { name: 'A' })).id
  b = (await createProject(f.env, await f.actor(), { name: 'B' })).id
  f.db.prepare('INSERT INTO task_boards(id,name,created_by) VALUES(?,?,?)').run('shared-board', 'Shared board', ids.owner)
})
afterEach(() => f.db.close())
const assign = async (memberId: string, projectId: string, policy = 'developer') => assignProjectPolicy(f.env, await f.actor(), projectId, { policyId: 'project-policy-' + policy, memberId })
const task = async (projectId: string | null) => createTask(f.env, await f.actor(), 'shared-board', { projectId, title: 'Work', description: 'Private body', priority: 'normal', dueAt: null, assigneeId: null, channelId: null, labelIds: [], dependencyIds: [] }, () => {})

it('seeds reusable policies without assigning or expanding anyone’s existing role', async () => {
  const policies = (await listProjectPolicies(f.env)).filter(p => !p.id.startsWith('fixture-'))
  expect(policies.map(p => p.name)).toEqual(['Coordinator', 'Developer', 'Reviewer', 'Server administrator', 'Server member', 'Server owner', 'Task coordinator'])
  expect(policies.filter(p => p.id.startsWith('project-policy-')).every(p => (p.permissions & ~ProjectPolicyPermissions) === 0)).toBe(true)
  expect(f.db.prepare('SELECT count(*) AS n FROM grants').get()!.n).toBe(0)
  expect((await f.actor(ids.member)).principal.permissions).toBe(MemberPermissions)
})
it('preserves each project grant in a conversation Run and revokes it when access changes', async () => {
  const first = await assign(ids.agent, a)
  await assign(ids.agent, b, 'reviewer')
  const { run } = await f.run()
  const auth = await runAuthorization(f.env, run)
  expect(projectPermissionAllowed(auth, a, Permission.proposeCode)).toBe(true)
  expect(projectPermissionAllowed(auth, b, Permission.proposeCode)).toBe(false)
  await revokeProjectPolicy(f.env, await f.actor(), a, first.id)
  await expect(runAuthorization(f.env, run)).rejects.toMatchObject({ statusCode: 403 })
})
it.each([ids.member, ids.agent])('keeps Developer A and Reviewer B separate for member %s', async memberId => {
  await assign(memberId, a); await assign(memberId, b, 'reviewer')
  const first = await task(a), second = await task(b), unscoped = await task(null)
  const auth = await f.actor(memberId)
  expect((await listProjects(f.env, auth)).map(p => p.id)).toEqual([a,b])
  expect((await listTasks(f.env, auth)).flatMap(board => board.tasks).map(t => t.id)).toEqual([first.id,second.id])
  expect(await getTask(f.env, auth, second.id)).toMatchObject({ id: second.id })
  expect(await updateTask(f.env, auth, first.id, { title: 'Implemented' }, () => {})).toMatchObject({ title: 'Implemented' })
  await expect(updateTask(f.env, auth, second.id, { title: 'Unauthorized' }, () => {})).rejects.toMatchObject({ statusCode: 403 })
  await expect(getTask(f.env, auth, unscoped.id)).rejects.toMatchObject({ statusCode: 403 })
  expect(projectPermissionAllowed(auth, a, Permission.proposeCode)).toBe(true)
  expect(projectPermissionAllowed(auth, b, Permission.proposeCode)).toBe(false)
  expect(() => authorize(auth, ServerAction.proposeCode)).toThrow()
  expect(() => authorize({ ...auth, projectScope: { id: a } }, ServerAction.proposeCode)).not.toThrow()
  expect(() => authorize({ ...auth, projectScope: { id: b } }, ServerAction.proposeCode)).toThrow()
})
it('checks both ends of a task move and prevents laundering a read-only task through another project', async () => {
  await assign(ids.member,a); await assign(ids.member,b,'reviewer')
  const first=await task(a), second=await task(b), auth=await f.actor(ids.member)
  await expect(updateTask(f.env,auth,first.id,{projectId:b},()=>{})).rejects.toMatchObject({statusCode:403})
  await expect(updateTask(f.env,auth,second.id,{projectId:a},()=>{})).rejects.toMatchObject({statusCode:403})
  await expect(createTask(f.env,auth,'shared-board',{projectId:b,title:'Denied',description:'',priority:'normal',dueAt:null,assigneeId:null,channelId:null,labelIds:[],dependencyIds:[]},()=>{})).rejects.toMatchObject({statusCode:403})
})
it('does not combine a role’s write flag with a different policy’s repository access', async () => {
  await assign(ids.member,b,'reviewer')
  f.db.prepare('UPDATE roles SET permissions_bitmask=?,resource_access_json=? WHERE id=?').run(MemberPermissions|Permission.proposeCode,JSON.stringify({repositories:['11']}),ids.memberRole)
  const auth={...await f.actor(ids.member),projectScope:{id:b,repositoryId:'22'}}
  expect(() => authorize(auth,ServerAction.proposeCode)).toThrow()
})
it('supports role assignments and direct assignments without changing the Server role', async () => {
  await assignProjectPolicy(f.env,await f.actor(),a,{policyId:'project-policy-developer',roleId:ids.memberRole})
  await assign(ids.member,b,'reviewer')
  const auth=await f.actor(ids.member)
  expect(auth.principal.roleId).toBe(ids.memberRole)
  expect(projectPermissionAllowed(auth,a,Permission.writeTasks)).toBe(true)
  expect(projectPermissionAllowed(auth,b,Permission.writeTasks)).toBe(false)
})
it('denies self-assignment and cannot smuggle Server administration into a project policy', async () => {
  await expect(assignProjectPolicy(f.env,await f.actor(ids.member),a,{policyId:'project-policy-developer',memberId:ids.member})).rejects.toMatchObject({statusCode:403})
  const serverPolicy = await saveProjectPolicy(f.env,await f.actor(),{name:'Server access',permissions:Permission.manageServer})
  await expect(assignProjectPolicy(f.env,await f.actor(),a,{policyId:serverPolicy.id,memberId:ids.member})).rejects.toMatchObject({statusCode:400})
  await expect(saveProjectPolicy(f.env,await f.actor(),{name:'Overflow',permissions:2 ** 32 + Permission.readProjects})).rejects.toThrow()
})
it('revokes fresh access immediately and versions changes to reusable policies', async () => {
  const assignment=await assign(ids.member,a)
  await revokeProjectPolicy(f.env,await f.actor(),a,assignment.id)
  expect(projectPermissionAllowed(await f.actor(ids.member),a,Permission.writeTasks)).toBe(false)
  const current=(await listProjectPolicies(f.env)).find(p=>p.id==='project-policy-reviewer')!
  expect(await saveProjectPolicy(f.env,await f.actor(),{name:current.name,description:'Updated',permissions:current.permissions,version:current.version},current.id)).toMatchObject({version:current.version+1})
  await expect(saveProjectPolicy(f.env,await f.actor(),{name:current.name,description:'Stale',permissions:current.permissions,version:current.version},current.id)).rejects.toMatchObject({statusCode:409})
})
it('derives a role’s permissions from its policies and removes them on revocation', async () => {
  f.db.prepare('DELETE FROM role_policies WHERE role_id=?').run(ids.agentRole)
  const policy = await saveProjectPolicy(f.env, await f.actor(), { name: 'Data reader', permissions: Permission.readData })
  const second = await saveProjectPolicy(f.env, await f.actor(), { name: 'Task reader', permissions: Permission.readTasks })
  f.db.prepare('INSERT INTO role_policies(role_id,policy_id) VALUES (?,?)').run(ids.agentRole, policy.id)
  f.db.prepare('INSERT INTO role_policies(role_id,policy_id) VALUES (?,?)').run(ids.agentRole, second.id)
  let auth = await f.actor(ids.agent)
  expect(auth.principal.permissions & (Permission.readData | Permission.readTasks)).toBe(Permission.readData | Permission.readTasks)
  await saveProjectPolicy(f.env, await f.actor(), { name: policy.name, description: '', permissions: Permission.writeData, version: policy.version }, policy.id)
  auth = await f.actor(ids.agent)
  expect(auth.principal.permissions & Permission.readData).toBe(0)
  expect(auth.principal.permissions & Permission.writeData).toBe(Permission.writeData)
  f.db.prepare('DELETE FROM role_policies WHERE role_id=? AND policy_id=?').run(ids.agentRole, second.id)
  expect((await f.actor(ids.agent)).principal.permissions & Permission.readTasks).toBe(0)
  f.db.prepare('DELETE FROM project_policies WHERE id=?').run(policy.id)
  expect((await f.actor(ids.agent)).principal.permissions & Permission.writeData).toBe(0)
})
it('bounds an Agent Run to its project and original grants, then stops it after access is revoked', async () => {
  const assigned = await assign(ids.agent,a)
  await assign(ids.member,a)
  await assign(ids.agent,b,'reviewer'); await assign(ids.member,b,'reviewer')
  const work=await task(a), other=await task(b)
  await updateTask(f.env,await f.actor(),work.id,{assigneeId:ids.agent},()=>{})
  const {run,authorization}=await f.run(ids.member,undefined,work.id)
  expect(() => authorize(authorization,ServerAction.proposeCode)).not.toThrow()
  await expect(getTask(f.env,authorization,other.id)).rejects.toMatchObject({statusCode:403})
  await revokeProjectPolicy(f.env,await f.actor(),a,assigned.id)
  await expect(runAuthorization(f.env,run)).rejects.toMatchObject({statusCode:403})
})
it('does not expand an admitted Reviewer Run after a Developer assignment is added', async () => {
  await assign(ids.agent,b,'reviewer');await assign(ids.member,b,'reviewer')
  const work=await task(b)
  await updateTask(f.env,await f.actor(),work.id,{assigneeId:ids.agent},()=>{})
  const {run}=await f.run(ids.member,undefined,work.id)
  await assign(ids.agent,b);await assign(ids.member,b)
  const current=await runAuthorization(f.env,run)
  expect(() => authorize(current,ServerAction.proposeCode)).toThrow()
})
it('does not revive an old Run when its assignment changes Developer -> Reviewer -> Developer', async () => {
  const original=await assign(ids.agent,a); await assign(ids.member,a)
  const work=await task(a);await updateTask(f.env,await f.actor(),work.id,{assigneeId:ids.agent},()=>{})
  const {run}=await f.run(ids.member,undefined,work.id)
  const reviewer=await replaceProjectPolicy(f.env,await f.actor(),a,original.id,{policyId:'project-policy-reviewer'})
  await replaceProjectPolicy(f.env,await f.actor(),a,reviewer.id,{policyId:'project-policy-developer'})
  await expect(runAuthorization(f.env,run)).rejects.toMatchObject({statusCode:403})
})
it('keeps MCP credential scopes in force when a project policy grants task writes', async () => {
  await assign(ids.member,a)
  f.db.prepare('UPDATE roles SET permissions_bitmask=? WHERE id=?').run(MemberPermissions|Permission.mcpConnect,ids.memberRole)
  const work=await task(a), base=await f.actor(ids.member)
  const auth={...base,credential:{kind:'mcp' as const,scopes:['tasks:read' as const]}}
  await expect(updateTask(f.env,auth,work.id,{title:'Denied'},()=>{})).rejects.toMatchObject({statusCode:403})
})

it('hides dependencies in inaccessible projects in lists, details and mutation responses', async () => {
  const first = await task(a), hidden = await task(b)
  await updateTask(f.env, await f.actor(), first.id, { dependencyIds: [hidden.id] }, () => {})
  await assign(ids.member, a)
  const auth = await f.actor(ids.member)
  expect((await getTask(f.env, auth, first.id))?.dependencyIds).toEqual([])
  expect((await listTasks(f.env, auth)).flatMap(board => board.tasks).find(row => row.id === first.id)?.dependencyIds).toEqual([])
  expect((await updateTask(f.env, auth, first.id, { title: 'Still private' }, () => {})).dependencyIds).toEqual([])
  await expect(updateTask(f.env, auth, first.id, { dependencyIds: [hidden.id] }, () => {})).rejects.toMatchObject({ statusCode: 403 })
})
