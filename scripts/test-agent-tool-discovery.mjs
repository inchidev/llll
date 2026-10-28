import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { Permission } from '../shared/permissions.ts'
import { createFixtureRole } from './test-role-fixture.mjs'

/** Real authenticated HTTP and D1; no external model or GitHub repository. */
export async function testAgentToolDiscovery({ api, runtimes, ids, signingSecret, channelId }) {
  const root = `/api/servers/${ids.alpha}`
  const db = await runtimes.alpha.getD1Database('DB')
  const permissions = Permission.sendMessages | Permission.readTasks
  const role = await createFixtureRole({ api, runtimes, ids }, { name: 'Discovery fixture', permissions })
  const agent = (await api('alpha', root + '/agents', { method: 'POST', body: { displayName: 'Discovery fixture', roleId: role.id } })).payload.agent
  const owner = (await db.prepare('SELECT owner_id FROM server').first()).owner_id
  const sessionId = crypto.randomUUID(), runId = crypto.randomUUID(), now = new Date().toISOString()
  const mandate = JSON.stringify({ permissions, agentPermissions: permissions, computer: false, maxSteps: 20, maxModelCalls: 20, maxToolCalls: 100, maxTokens: 64000 })
  await db.prepare('INSERT INTO agent_sessions(id,agent_id,channel_id,created_at,updated_at) VALUES(?,?,?,?,?)').bind(sessionId, agent.id, channelId, now, now).run()
  await db.prepare(`INSERT INTO agent_runs(id,session_id,agent_id,channel_id,initiated_by,idempotency_key,status,prompt,model,instructions,mandate_json,deadline,created_at,updated_at)
    VALUES(?,?,?,?,?,?,'running','Read permitted tasks','fixture','',?,?,?,?)`).bind(runId, sessionId, agent.id, channelId, owner, runId, mandate, new Date(Date.now() + 60000).toISOString(), now, now).run()
  const token = createHmac('sha256', signingSecret).update('agent-run:' + runId).digest('hex')
  let next = 0
  const call = (name, args, expected = 200) => api('alpha', `/api/agent-runs/${runId}/gateway/tools`, {
    actor: 'anonymous', method: 'POST', headers: { Authorization: `Bearer ${token}` },
    body: { callId: `discovery-${++next}`, name, arguments: args }, expected,
  })
  try {
    const search = (await call('search_tools', { query: 'read tasks' })).payload
    assert.ok(search.tools.some(tool => tool.name === 'list_tasks'))
    assert.ok(!JSON.stringify(search).includes('parameters'))
    assert.ok(!search.tools.some(tool => tool.name.includes('code') || tool.effect === 'write'))
    const selected = (await call('get_tool_details', { name: 'list_tasks', purpose: 'Find accessible work' })).payload
    assert.equal(selected.tool.parameters.type, 'object')
    assert.equal(selected.tool.guidance.effect, 'read')
    const result = (await call('list_tasks', {})).payload
    assert.ok(Array.isArray(result.boards))
    await call('get_tool_details', { name: 'create_record', purpose: 'Try a forbidden write' }, 403)
    await call('create_record', {}, 403)
    await db.prepare('UPDATE roles SET permissions_bitmask=? WHERE id=?').bind(Permission.sendMessages, role.id).run()
    await call('search_tools', { query: 'tasks' }, 403)
    await call('list_tasks', {}, 403)
    assert.equal((await db.prepare('SELECT count(*) AS n FROM agent_model_calls WHERE run_id=?').bind(runId).first()).n, 0)
    console.log('PASS: non-GitHub HTTP tool discovery, lazy schema, scoped read, forged write denial and Role revocation without inference')
  } finally {
    await db.prepare("UPDATE agent_runs SET status='failed' WHERE id=?").bind(runId).run()
    await db.prepare("UPDATE agents SET status='paused' WHERE user_id=?").bind(agent.id).run()
  }
}
