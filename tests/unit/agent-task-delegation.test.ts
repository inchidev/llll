import { afterEach, beforeEach, expect, it } from 'vitest'
import { ids, mcpFixture } from '../helpers/outbound-mcp'
import { MemberPermissions, Permission } from '../../shared/permissions'
import { authorize, ServerAction } from '../../shared/authorization'
import { createProject } from '../../server/utils/project-service'
import { assignProjectPolicy, revokeProjectPolicy } from '../../server/utils/project-policies'
import { createTask } from '../../server/utils/task-service'
import { delegateProjectTask, delegatedRunResult } from '../../server/utils/agent-task-delegation'
import { findAgentRun, runAuthorization } from '../../server/utils/agent-run-service'
import { reserveRunInference } from '../../server/utils/agent-inference-budget'
import { executeRunTool } from '../../server/utils/agent-tools'
import type { AgentRun } from '../../shared/agent-execution'
let f: ReturnType<typeof mcpFixture>, projectId: string, parent: AgentRun, childTaskId: string, coordinatorGrantId: string
const developer = '00000000-0000-4000-8000-000000000088'
beforeEach(async () => {
  f = mcpFixture()
  Object.assign(f.env, { SERVER_DO: { getByName: () => ({ notifyTasksChanged: async () => {} }) } })
  f.db.prepare('UPDATE roles SET permissions_bitmask=? WHERE id=?').run(MemberPermissions, ids.agentRole)
  f.db.prepare("INSERT INTO users(id,kind,display_name,status,role_id,joined_at) VALUES(?,'agent','Developer','active',?,'2026-10-27')").run(developer, ids.agentRole)
  f.db.prepare("INSERT INTO agents(user_id,created_by,harness,model) VALUES(?,?,'pi','')").run(developer, ids.owner)
  const owner = await f.actor()
  projectId = (await createProject(f.env, owner, { name: 'Shared project' })).id
  const grant = await assignProjectPolicy(f.env, owner, projectId, { policyId: 'project-policy-task-coordinator', memberId: ids.agent })
  coordinatorGrantId = grant.id
  await assignProjectPolicy(f.env, owner, projectId, { policyId: 'project-policy-developer', memberId: developer })
  f.db.prepare('INSERT INTO task_boards(id,name,created_by) VALUES(?,?,?)').run('work-board', 'Work', ids.owner)
  const task = async (assigneeId: string) => createTask(f.env, owner, 'work-board', { projectId, title: 'Work', description: 'Bounded work', priority: 'normal', dueAt: null, assigneeId, channelId: null, labelIds: [], dependencyIds: [] }, () => {})
  const rootTask = await task(ids.agent)
  childTaskId = (await task(developer)).id
  parent = (await f.run(ids.owner, undefined, rootTask.id)).run
})
afterEach(() => f.db.close())
it('lets a coordinator without computer permission start a developer without acquiring its tools', async () => {
  const auth = await runAuthorization(f.env, parent)
  expect(() => authorize(auth, ServerAction.useComputer)).toThrow()
  const result = await delegateProjectTask(f.env, parent, auth, childTaskId)
  const child = (await findAgentRun(f.env, result.runId))!
  expect(child.agentId).toBe(developer)
  expect(JSON.parse(child.mandateJson)).toMatchObject({ parentRunId: parent.id, rootRunId: parent.id, projectId, depth: 1, computer: true })
  expect(() => authorize(auth, ServerAction.useComputer)).toThrow()
  const childAuth = await runAuthorization(f.env, child)
  expect(() => authorize(childAuth, ServerAction.useComputer)).not.toThrow()
  expect(() => authorize(childAuth, ServerAction.writeRecords)).toThrow()
  const duplicate = await delegateProjectTask(f.env, parent, auth, childTaskId)
  expect(duplicate.runId).toBe(child.id)
  expect(await delegatedRunResult(f.env, parent, child.id)).toMatchObject({ agentId: developer, status: 'queued' })
})
it('revokes descendants when the coordinating project grant is removed', async () => {
  const result = await delegateProjectTask(f.env, parent, await runAuthorization(f.env, parent), childTaskId)
  await revokeProjectPolicy(f.env, await f.actor(), projectId, coordinatorGrantId)
  await expect(runAuthorization(f.env, (await findAgentRun(f.env, result.runId))!)).rejects.toMatchObject({ statusCode: 403 })
})
it('shares the model budget across the original run and delegated work', async () => {
  const mandate = JSON.parse(parent.mandateJson); mandate.maxModelCalls = 2
  f.db.prepare('UPDATE agent_runs SET mandate_json=?,model_calls=1 WHERE id=?').run(JSON.stringify(mandate), parent.id)
  parent = (await findAgentRun(f.env, parent.id))!
  const result = await delegateProjectTask(f.env, parent, await runAuthorization(f.env, parent), childTaskId)
  f.db.prepare("UPDATE agent_runs SET status='running' WHERE id=?").run(result.runId)
  const child = (await findAgentRun(f.env, result.runId))!
  expect(await reserveRunInference(f.env, child, 1000)).toMatchObject({ ok: true })
  expect(await reserveRunInference(f.env, child, 1000)).toMatchObject({ ok: false })
  expect(f.db.prepare('SELECT SUM(model_calls) AS calls FROM agent_runs').get()!.calls).toBe(2)
})
it('waits on the same delegated run and returns its result without creating duplicates', async () => {
  const auth = await runAuthorization(f.env, parent)
  const call = { callId: 'delegate-once', name: 'delegate_task', arguments: { taskId: childTaskId } }
  const first = await executeRunTool(f.env, parent.id, auth, call, () => {}) as { runId: string; delegationPending: boolean }
  expect(first.delegationPending).toBe(true)
  const waiting = await executeRunTool(f.env, parent.id, auth, call, () => {})
  expect(waiting).toMatchObject({ runId: first.runId, delegationPending: true })
  f.db.prepare("UPDATE agent_runs SET status='completed',result_text='Implementation verified' WHERE id=?").run(first.runId)
  expect(await executeRunTool(f.env, parent.id, auth, call, () => {})).toMatchObject({ runId: first.runId, delegationPending: false, result: 'Implementation verified' })
  expect(f.db.prepare('SELECT count(*) AS n FROM agent_runs WHERE agent_id=?').get(developer)!.n).toBe(1)
})
it('admits a distinct reviewed attempt while deduplicating each attempt', async () => {
  const auth = await runAuthorization(f.env, parent)
  const first = await delegateProjectTask(f.env, parent, auth, childTaskId, 1)
  const second = await delegateProjectTask(f.env, parent, auth, childTaskId, 2, 'Remove the review marker')
  expect(second.runId).not.toBe(first.runId)
  expect((await findAgentRun(f.env, second.runId))?.prompt).toContain('Remove the review marker')
  expect((await delegateProjectTask(f.env, parent, auth, childTaskId, 2, 'Remove the review marker')).runId).toBe(second.runId)
  await expect(delegateProjectTask(f.env, parent, auth, childTaskId, 2, 'Different instructions')).rejects.toMatchObject({ statusCode: 409 })
  expect(f.db.prepare('SELECT count(*) AS n FROM agent_runs WHERE agent_id=?').get(developer)!.n).toBe(2)
})
it('denies current-task delegation and agents without the delegation grant', async () => {
  const auth = await runAuthorization(f.env, parent)
  await expect(delegateProjectTask(f.env, parent, auth, parent.taskId!)).rejects.toMatchObject({ statusCode: 403 })
  f.db.prepare('UPDATE project_policies SET permissions_bitmask=permissions_bitmask & ~?,version=version+1 WHERE id=?').run(Permission.delegateTasks, 'project-policy-task-coordinator')
  await expect(runAuthorization(f.env, parent)).rejects.toMatchObject({ statusCode: 403 })
})
