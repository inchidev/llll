import assert from 'node:assert/strict'
import { ALL_PERMISSIONS, Permission } from '../shared/permissions.ts'
import { createFixtureRole } from './test-role-fixture.mjs'

export async function testRunPublication({ api, runtimes, ids, channelId }) {
  const db = await runtimes.alpha.getD1Database('DB'), root = `/api/servers/${ids.alpha}`
  const role = await createFixtureRole({ api, runtimes, ids }, { name: 'Publication fixture', permissions: Permission.sendMessages })
  const agent = (await api('alpha', root + '/agents', { method: 'POST', body: { displayName: 'Publication fixture', roleId: role.id } })).payload.agent
  const owner = (await db.prepare('SELECT owner_id FROM server').first()).owner_id
  const runId = crypto.randomUUID(), sessionId = crypto.randomUUID(), now = new Date().toISOString(), text = 'Private publication sentinel: <script>untrusted payload</script>.'
  await db.prepare('INSERT INTO agent_sessions(id,agent_id,channel_id,created_at,updated_at) VALUES(?,?,?,?,?)').bind(sessionId, agent.id, channelId, now, now).run()
  await db.prepare(`INSERT INTO agent_runs(id,session_id,agent_id,channel_id,initiated_by,idempotency_key,status,prompt,model,instructions,mandate_json,deadline,created_at,updated_at,result_text)
    VALUES(?,?,?,?,?,?,'completed','Private publication fixture','fixture','',?,?,?,?,?)`).bind(runId, sessionId, agent.id, channelId, owner, runId,
      JSON.stringify({ permissions: ALL_PERMISSIONS, agentPermissions: Permission.sendMessages, computer: false, maxSteps: 20, maxModelCalls: 20, maxToolCalls: 100, maxTokens: 64000 }), new Date(Date.now() + 60000).toISOString(), now, now, text).run()
  const endpoint = `/api/agent-runs/${runId}/publication`
  const prepare = async () => (await api('alpha', endpoint, { method: 'POST', body: { action: 'prepare' } })).payload.publication
  const decide = (p, decision = 'approve', expected = 200) => api('alpha', endpoint, { method: 'POST', body: { action: 'decide', id: p.id, digest: p.digest, decision }, expected })
  try {
    await api('alpha', endpoint, { actor: 'anonymous', method: 'POST', body: { action: 'prepare' }, expected: 401 })
    await api('alpha', endpoint, { actor: 'alpha-member', method: 'POST', body: { action: 'prepare' }, expected: 403 })
    await api('beta', endpoint, { method: 'POST', body: { action: 'prepare' }, expected: 404 })
    const first = await prepare()
    assert.equal(first.content, text)
    assert.equal(first.status, 'pending')
    assert.equal((await db.prepare('SELECT count(*) AS n FROM messages WHERE content=?').bind(text).first()).n, 0)
    await api('alpha', endpoint, { method: 'POST', body: { action: 'decide', id: first.id, digest: first.digest, decision: 'approve', content: 'Unreviewed replacement' }, expected: 400 })
    await decide({ ...first, digest: '0'.repeat(64) }, 'approve', 409)
    await decide(first, 'reject')
    await decide(first, 'approve', 409)
    const second = await prepare()
    await db.prepare("UPDATE agent_run_publications SET expires_at='2000-01-01' WHERE id=?").bind(second.id).run()
    await decide(second, 'approve', 409)
    const third = await prepare()
    await db.prepare("UPDATE agents SET status='paused' WHERE user_id=?").bind(agent.id).run()
    await decide(third, 'approve', 403)
    await db.prepare("UPDATE agents SET status='active' WHERE user_id=?").bind(agent.id).run()
    const done = (await decide(third)).payload.publication
    assert.equal(done.status, 'completed')
    assert.equal(done.decidedBy, owner)
    const message = await db.prepare('SELECT content,author_id AS author,channel_id AS channel FROM messages WHERE id=?').bind(done.messageId).first()
    assert.deepEqual(message, { content: text, author: agent.id, channel: channelId })
    await decide(third)
    assert.equal((await db.prepare('SELECT count(*) AS n FROM messages WHERE content=?').bind(text).first()).n, 1)
    assert.equal((await prepare()).id, third.id)
    assert.equal((await api('alpha', `/api/agent-runs/${runId}`)).payload.publication.status, 'completed')
    await api('alpha', `/api/agent-runs/${runId}`, { actor: 'alpha-member', expected: 403 })
    const audit = (await api('alpha', root + '/audit')).payload
    assert.equal(JSON.stringify(audit).includes(text), false)
    console.log('PASS: real Worker exact publication review, private payload, digest/expiry/revocation rejection, human approval, Channel DO persistence and idempotent receipt')
    return { runId, publicationId: third.id, messageId: done.messageId }
  } finally { await db.prepare("UPDATE agents SET status='paused' WHERE user_id=?").bind(agent.id).run() }
}
