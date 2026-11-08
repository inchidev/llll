import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createError } from 'h3'
import { d1 } from '../helpers/sqlite-d1'
import { INIT_SQL } from '../../server/utils/db'
import { loadAuthorizationContext } from '../../server/utils/authorization'
import { createAgentRun, findAgentRun } from '../../server/utils/agent-run-service'
import { agentWebhookPayload, saveAgentWebhook } from '../../server/utils/agent-webhooks'
import { grantAgentAccess } from '../../server/utils/agent-access'
import { saveProjectPolicy } from '../../server/utils/project-policies'
import { authenticateMcpRequest } from '../../server/utils/mcp-access'
import { runMcpCredential } from '../../server/utils/mcp-run-credential'
import { serveMcpRequest } from '../../server/utils/mcp-server'
import type { McpPrincipal } from '../../server/utils/mcp-principal'
import { Permission } from '../../shared/permissions'
import type { L4Env } from '../../workers/env'

/**
 * inchidev/llll#7: an external Agent answered over MCP with a credential no Run bound, so a person who
 * could wake it reached the Agent's whole Role. The webhook now carries a credential for that Run, and
 * every tool call made with it is authorized as the Run is: the Agent's Role, no higher than the person who asked.
 */
let db: DatabaseSync, env: L4Env
const SERVER = '00000000-0000-4000-8000-000000000001'
const agentId = '00000000-0000-4000-8000-000000000002'
const petya = '00000000-0000-4000-8000-000000000003'
const vanya = '00000000-0000-4000-8000-000000000004'
const agentRole = Permission.mcpConnect | Permission.sendMessages | Permission.readTasks | Permission.writeTasks
beforeEach(() => {
  vi.stubGlobal('createError', createError)
  db = new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys=ON'); db.exec(INIT_SQL)
  db.exec(`INSERT INTO server_identity(singleton,id) VALUES(1,'${SERVER}');
    INSERT INTO roles(id,key,name,permissions_bitmask,resource_access_json) VALUES('owner-role','owner','Owner',0,'{}'),
      ('agent-role','custom:agent','Assistant',${agentRole},'{}'),
      ('reader-role','custom:reader','Reader',${Permission.useAgents | Permission.sendMessages | Permission.readTasks},'{}'),
      ('writer-role','custom:writer','Writer',${Permission.useAgents | Permission.sendMessages | Permission.readTasks | Permission.writeTasks},'{}');
    INSERT INTO users(id,kind,display_name,status,role_id,joined_at) VALUES('owner-user','human','Owner','active','owner-role','2026-10-21'),
      ('${agentId}','agent','Grok','active','agent-role','2026-10-21'),
      ('${petya}','human','Petya','active','reader-role','2026-10-21'),
      ('${vanya}','human','Vanya','active','writer-role','2026-10-21');
    INSERT INTO server(id,name,owner_id) VALUES('${SERVER}','L4','owner-user');
    INSERT INTO agents(user_id,created_by,harness,model) VALUES('${agentId}','owner-user','pi','');
    INSERT INTO channels(id,name,type,visibility) VALUES('public-chat','General','text','server');
    INSERT INTO task_boards(id,name,created_by) VALUES('board-roadmap','Roadmap','owner-user');`)
  env = { DB: d1(db), AUTH_SECRET: 'test-server-secret-with-32-characters', PUBLIC_ORIGIN: 'https://team.example',
    AGENT_RUN_DO: { getByName: () => ({ wake: async () => {} }) },
    SERVER_DO: { getByName: () => ({ notifyTasksChanged: async () => {} }) },
    CHANNEL_DO: { getByName: () => ({ postAgentMessage: async () => ({ id: 'note', channelId: 'public-chat' }), fanout: async () => {} }) },
  } as unknown as L4Env
})
afterEach(() => { vi.unstubAllGlobals(); db.close() })

const actor = async (id: string) => (await loadAuthorizationContext(env, { principalId: id, credential: { kind: 'session' } }))!
/** A webhook Agent answers only holders of its access: both people hold a Policy that adds nothing. */
async function external() {
  await saveAgentWebhook(env, agentId, 'owner-user', { url: 'https://hooks.grok.example/routine/abc', headerValue: 'Bearer sender-key' })
  const owner = await actor('owner-user')
  const policy = (await saveProjectPolicy(env, owner, { name: 'May ask', permissions: 0 })).id
  for (const memberId of [petya, vanya]) await grantAgentAccess(env, owner, agentId, { policyId: policy, memberId })
}
/** The Run as the webhook sees it: running, with the credential its payload carries. */
async function wake(by: string) {
  const created = await createAgentRun(env, await actor(by), { agentId, channelId: 'public-chat', prompt: 'Add a task for the launch', idempotencyKey: crypto.randomUUID() })
  db.prepare("UPDATE agent_runs SET status='running' WHERE id=?").run(created.id)
  const run = (await findAgentRun(env, created.id))!
  const payload = await agentWebhookPayload(env, run)
  return { run, token: payload.server.credential!.token, payload }
}
const authenticate = (token: string) => authenticateMcpRequest(env, new Request('https://team.example/mcp', { headers: { Authorization: `Bearer ${token}` } }))
async function call(principal: McpPrincipal, name: string, args: Record<string, unknown>) {
  const response = await serveMcpRequest(new Request('https://team.example/mcp', {
    method: 'POST', headers: { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json', Host: 'team.example' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  }), { env, principal, schedule: () => {} })
  const body = await response.text()
  const json = body.startsWith('event:') ? body.split('\ndata: ')[1]?.trim() : body
  const { result } = JSON.parse(json!) as { result: { content: Array<{ type: string; text: string }>; isError?: boolean } }
  const text = result.content[0]!.text
  let value: Record<string, unknown>
  try { value = JSON.parse(text) as Record<string, unknown> } catch { value = { text } }
  return { isError: result.isError === true, value }
}

describe('an external Agent’s Run credential', () => {
  it('is carried by the webhook and authenticates as the Agent for the person who asked', async () => {
    await external()
    const { run, token, payload } = await wake(petya)
    expect(payload.server).toMatchObject({ mcp: 'https://team.example/mcp', credential: { token: expect.stringMatching(/^dfrun_[0-9a-f-]{36}_[0-9a-f]{64}$/u), expiresAt: run.deadline } })
    expect(token).toBe(await runMcpCredential(env, run.id))
    const principal = await authenticate(token)
    expect(principal).toMatchObject({ userId: agentId, delegatedBy: petya, tokenId: `run:${run.id}`, isOwner: false })
    expect(principal!.authorization.credential).toMatchObject({ kind: 'mcp', id: `run:${run.id}` })
    expect(principal!.authorization.delegation).toMatchObject({ by: petya })
  })

  it('keeps the Agent no higher than the person who asked: Petya cannot write Tasks through it, Vanya can', async () => {
    await external()
    const asPetya = (await authenticate((await wake(petya)).token))!
    const read = await call(asPetya, 'list_task_boards', { includeArchived: false })
    expect(read.isError).toBe(false)
    const refused = await call(asPetya, 'create_task', { boardId: 'board-roadmap', title: 'Launch' })
    expect(refused.isError).toBe(true)
    expect(refused.value).toEqual({ error: { code: 'forbidden', message: 'create_task is not available: The delegating Reader cannot perform tasks:write' } })
    expect(db.prepare('SELECT count(*) AS count FROM tasks').get()).toMatchObject({ count: 0 })

    const asVanya = (await authenticate((await wake(vanya)).token))!
    const created = await call(asVanya, 'create_task', { boardId: 'board-roadmap', title: 'Launch' })
    expect(created.isError, JSON.stringify(created.value)).toBe(false)
    expect(db.prepare('SELECT title,created_by AS createdBy FROM tasks').get()).toMatchObject({ title: 'Launch', createdBy: agentId })
    // The Agent's own Role is still the ceiling: the Owner asking does not make it read Data.
    const asOwner = (await authenticate((await wake('owner-user')).token))!
    const data = await call(asOwner, 'list_tables', {})
    expect(data.isError).toBe(true)
    expect(data.value).toMatchObject({ error: { message: expect.stringContaining('The Assistant role cannot perform data:read') } })
  })

  it('completes only its own Run', async () => {
    await external()
    const first = await wake(petya)
    const second = await wake(vanya)
    const principal = (await authenticate(first.token))!
    const other = await call(principal, 'complete_run', { runId: second.run.id, outcome: 'failed', note: 'Not mine' })
    expect(other.isError).toBe(true)
    expect(other.value).toEqual({ text: 'Run not found' })
    expect(db.prepare('SELECT status FROM agent_runs WHERE id=?').get(second.run.id)).toMatchObject({ status: 'running' })
    const own = await call(principal, 'complete_run', { runId: first.run.id, outcome: 'failed', note: 'Could not finish' })
    expect(own.isError, JSON.stringify(own.value)).toBe(false)
    expect(db.prepare('SELECT status FROM agent_runs WHERE id=?').get(first.run.id)).toMatchObject({ status: 'failed' })
    // A closed Run's credential no longer authenticates.
    expect(await authenticate(first.token)).toBeNull()
  })

  it('is refused when forged, expired, revoked, or not an external Agent’s', async () => {
    await external()
    const { run, token } = await wake(petya)
    expect(await authenticate(token.slice(0, -4) + '0000')).toBeNull()
    expect(await authenticate(`dfrun_${crypto.randomUUID()}_${'a'.repeat(64)}`)).toBeNull()
    db.prepare("UPDATE agent_runs SET deadline='2000-01-01T00:00:00.000Z' WHERE id=?").run(run.id)
    expect(await authenticate(token)).toBeNull()
    db.prepare("UPDATE agent_runs SET deadline='2999-01-01T00:00:00.000Z' WHERE id=?").run(run.id)
    expect(await authenticate(token)).toBeTruthy()
    // Removing Petya's access revokes the Run, and with it the credential.
    db.prepare('DELETE FROM grants WHERE member_id=?').run(petya)
    expect(await authenticate(token)).toBeNull()
    // Without Connect MCP clients the Agent cannot connect, Run or no Run.
    db.prepare("INSERT INTO grants(id,member_id,agent_id,policy_id,created_by,created_at) SELECT ?,?,?,id,?,? FROM project_policies WHERE name='May ask'").run(crypto.randomUUID(), petya, agentId, 'owner-user', new Date().toISOString())
    db.prepare('UPDATE roles SET permissions_bitmask=? WHERE id=?').run(agentRole & ~Permission.mcpConnect, 'agent-role')
    expect(await authenticate(token)).toBeNull()
    // An Agent without a webhook works through its Run's gateway, never through a Run credential.
    db.prepare('UPDATE roles SET permissions_bitmask=? WHERE id=?').run(agentRole, 'agent-role')
    db.prepare('DELETE FROM agent_webhooks WHERE agent_id=?').run(agentId)
    expect(await authenticate(token)).toBeNull()
  })
})
