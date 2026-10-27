import { afterEach, beforeEach, expect, it } from 'vitest'
import { mcpFixture, ids } from '../helpers/outbound-mcp'
import { ALL_PERMISSIONS, Permission } from '../../shared/permissions'
import { defaultAgentExecutionPolicy } from '../../shared/agent-execution-policy'
import { executeRunTool, toolsForRun } from '../../server/utils/agent-tools'
import { findAgentRun, runAuthorization } from '../../server/utils/agent-run-service'
import { markUntrustedContext, toolSecurityReason } from '../../server/utils/agent-tool-security'
let f: ReturnType<typeof mcpFixture>
beforeEach(() => {
  f = mcpFixture()
  f.env.SERVER_DO = { getByName: () => ({ notifyTasksChanged: async () => {} }) } as unknown as typeof f.env.SERVER_DO
  f.db.prepare('UPDATE roles SET permissions_bitmask=? WHERE id=?').run(ALL_PERMISSIONS, ids.agentRole)
  f.db.prepare('INSERT INTO task_boards(id,name,created_by) VALUES(?,?,?)').run('test-board', 'Work', ids.owner)
})
afterEach(() => f.db.close())
it('admits generous role-authorized limits and exposes permitted writes after reading untrusted content', async () => {
  const { run, authorization } = await f.run()
  expect(JSON.parse(run.mandateJson)).toMatchObject({ execution: defaultAgentExecutionPolicy(), maxToolCalls: 4096, maxTokens: 2000000 })
  await markUntrustedContext(f.env, run)
  expect((await toolsForRun(f.env, authorization, () => {}, run)).descriptors.some(t => t.name === 'create_task')).toBe(true)
  const result = await executeRunTool(f.env, run.id, authorization, { callId: 'write', name: 'create_task', arguments: { boardId: 'test-board', title: 'Authorized task' } }, () => {})
  expect(result).toMatchObject({ task: { title: 'Authorized task', assigneeId: ids.agent } })
  const again = await executeRunTool(f.env, run.id, authorization, { callId: 'write', name: 'create_task', arguments: { boardId: 'test-board', title: 'Authorized task' } }, () => {})
  expect(again).toEqual(result)
  expect(f.db.prepare('SELECT count(*) AS n FROM tasks').get()!.n).toBe(1)
})
it('revokes writes immediately when a current role loses the grant', async () => {
  const { run, authorization } = await f.run()
  f.db.prepare('UPDATE roles SET permissions_bitmask=? WHERE id=?').run(ALL_PERMISSIONS & ~Permission.writeTasks & ~Permission.manageTasks, ids.agentRole)
  await expect(executeRunTool(f.env, run.id, authorization, { callId: 'revoked', name: 'create_task', arguments: { boardId: 'test-board', title: 'Denied task' } }, () => {})).rejects.toMatchObject({ statusCode: 403 })
  expect(f.db.prepare('SELECT count(*) AS n FROM tasks').get()!.n).toBe(0)
})
it('stops identical-call loops without lowering the overall tool budget', async () => {
  const { run, authorization } = await f.run()
  for (let n = 0; n < 6; n++) await executeRunTool(f.env, run.id, authorization, { callId: `list-${n}`, name: 'list_tasks', arguments: {} }, () => {})
  await expect(executeRunTool(f.env, run.id, authorization, { callId: 'loop', name: 'list_tasks', arguments: {} }, () => {})).rejects.toMatchObject({ statusCode: 429 })
  expect(f.db.prepare('SELECT count(*) AS n FROM agent_run_tools WHERE run_id=?').get(run.id)!.n).toBe(6)
})
it('keeps legacy mandates in review mode, and never grants unclassified tools', async () => {
  const { run } = await f.run()
  const mandate = JSON.parse(run.mandateJson); delete mandate.execution
  f.db.prepare('UPDATE agent_runs SET mandate_json=? WHERE id=?').run(JSON.stringify(mandate), run.id)
  const old = (await findAgentRun(f.env, run.id))!
  const tools = await toolsForRun(f.env, await runAuthorization(f.env, old), () => {}, old)
  expect(tools.descriptors.some(t => t.name === 'create_task')).toBe(false)
  expect(toolSecurityReason('unknown', false, 'role')).toBe('unclassified_tool')
  expect(toolSecurityReason('read_url', true, 'role')).toBeNull()
})
it('returns ordinary conversation answers in the thread rather than a private Run link', async () => {
  const { run } = await f.run()
  const { runReport } = await import('../../server/utils/agent-tool-security')
  expect(await runReport(f.env, { ...run, status: 'completed', resultText: 'Привет! Вот ответ.' })).toMatchObject({ text: 'Привет! Вот ответ.', restricted: false })
})
it('keeps conversation results private after a restricted resource tool was used', async () => {
  const { run } = await f.run()
  f.db.prepare("INSERT INTO agent_run_tools(run_id,call_id,name,arguments_json,policy_json,status,result_json,created_at) VALUES(?,?,'get_task','{}','{}','completed','{}',?)").run(run.id, 'private-read', new Date().toISOString())
  const { runReport } = await import('../../server/utils/agent-tool-security')
  const report = await runReport(f.env, { ...run, status: 'completed', resultText: 'Private task content' })
  expect(report.restricted).toBe(true)
  expect(report.text).not.toContain('Private task content')
})
