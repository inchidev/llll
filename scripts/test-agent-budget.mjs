import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { Permission } from '../shared/permissions.ts'
import { createFixtureRole } from './test-role-fixture.mjs'

/** Hit the real gateway with an isolated runtime capability; no provider call is allowed. */
export async function testAgentBudget({ api, runtimes, ids, signingSecret, channelId }) {
  const root = `/api/servers/${ids.alpha}`
  const db = await runtimes.alpha.getD1Database('DB')
  const role = await createFixtureRole({ api, runtimes, ids }, { name: 'Budget fixture role', permissions: Permission.sendMessages })
  const agent = (await api('alpha', root + '/agents', { method: 'POST', body: { displayName: 'Budget fixture', roleId: role.id } })).payload.agent
  const owner = (await db.prepare('SELECT owner_id FROM server').first()).owner_id
  const sessionId = crypto.randomUUID(), runId = crypto.randomUUID(), now = new Date().toISOString()
  const mandate = JSON.stringify({ permissions: Permission.sendMessages, agentPermissions: Permission.sendMessages, computer: false, maxSteps: 20, maxModelCalls: 20, maxToolCalls: 100, maxTokens: 64000 })
  await db.prepare('INSERT INTO agent_sessions(id,agent_id,channel_id,created_at,updated_at) VALUES(?,?,?,?,?)').bind(sessionId, agent.id, channelId, now, now).run()
  await db.prepare(`INSERT INTO agent_runs(id,session_id,agent_id,channel_id,initiated_by,idempotency_key,status,prompt,model,instructions,mandate_json,deadline,created_at,updated_at)
    VALUES(?,?,?,?,?,?,'running','Budget fixture','fixture','',?,?,?,?)`).bind(runId, sessionId, agent.id, channelId, owner, runId, mandate, new Date(Date.now() + 60000).toISOString(), now, now).run()
  const token = createHmac('sha256', signingSecret).update('agent-run:' + runId).digest('hex')
  const path = `/api/agent-runs/${runId}/gateway/v1/chat/completions`
  try {
    await api('alpha', path, { actor: 'anonymous', method: 'POST', body: { messages: [{ role: 'user', content: 'Do not infer' }] }, expected: 401 })
    for (const [calls, tokens, code] of [[20, 0, 'run_model_call_limit'], [0, 63500, 'run_token_budget'], [0, 249500, 'agent_daily_token_budget']]) {
      // The daily-only case uses a larger Run ceiling while retaining the same agent ceiling.
      const limits = JSON.parse(mandate); if (code === 'agent_daily_token_budget') limits.maxTokens = 300000
      await db.prepare('UPDATE agent_runs SET model_calls=?,total_tokens=?,mandate_json=? WHERE id=?').bind(calls, tokens, JSON.stringify(limits), runId).run()
      const result = await api('alpha', path, { actor: 'anonymous', method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: { messages: [{ role: 'user', content: 'Do not infer' }] }, expected: 400 })
      assert.equal(result.payload.error.code, code)
      const stored = await db.prepare('SELECT model_calls,total_tokens,last_error FROM agent_runs WHERE id=?').bind(runId).first()
      assert.equal(stored.model_calls, calls); assert.equal(stored.total_tokens, tokens)
      assert.equal(stored.last_error, result.payload.error.message)
    }
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM agent_model_calls WHERE run_id=?').bind(runId).first()).n, 0)
    console.log('PASS: capability-authenticated gateway distinguishes call/Run/daily budget denials, persists the safe reason, spends no counters and makes no model call')
  } finally {
    await db.prepare("UPDATE agent_runs SET status='failed' WHERE id=?").bind(runId).run()
    await db.prepare("UPDATE agents SET status='paused' WHERE user_id=?").bind(agent.id).run()
  }
}
