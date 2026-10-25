import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { Permission } from '../shared/permissions.ts'

// Only the remote provider is replaced; the Worker uses the real MCP client and D1.
export async function outboundMcpFixture(request) {
  if (new URL(request.url).href !== 'https://docs.mcp.cloudflare.com/mcp') return null
  if (request.method !== 'POST') return new Response(null, { status: 405 })
  const rpc = await request.json()
  if (!('id' in rpc)) return new Response(null, { status: 202 })
  const result = rpc.method === 'initialize'
    ? { protocolVersion: rpc.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'Untrusted docs fixture', version: '1' } }
    : rpc.method === 'tools/list'
      ? { tools: [{ name: 'search_cloudflare_documentation', description: 'Search documentation', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }, annotations: { readOnlyHint: true } }] }
      : { content: [{ type: 'text', text: 'Documentation evidence: https://developers.cloudflare.com/workers/ ' + rpc.params.arguments.query }] }
  return new Response('event: message\r\ndata: ' + JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }) + '\r\n\r\n', { headers: { 'Content-Type': 'text/event-stream' } })
}
export async function testOutboundMcp({ api, runtimes, ids, signingSecret, channelId, memberId }) {
  const root = `/api/servers/${ids.alpha}`, endpoint = root + '/tool-connections'
  const db = await runtimes.alpha.getD1Database('DB')
  const permissions = Permission.sendMessages | Permission.useExternalTools
  const role = (await api('alpha', root + '/roles', { method: 'POST', body: { name: 'External docs fixture', permissions } })).payload.role
  const agent = (await api('alpha', root + '/agents', { method: 'POST', body: { displayName: 'External docs fixture', roleId: role.id } })).payload.agent
  const owner = (await db.prepare('SELECT owner_id FROM server').first()).owner_id
  const token = 'synthetic-private-mcp-http-token'
  const value = { name: 'Docs HTTP', providerId: 'cloudflare-docs', ownership: 'server', enabled: false, grants: { agentIds: [agent.id], memberIds: [owner], roleIds: [] }, toolNames: ['search_cloudflare_documentation'], credential: token, credentialExpiresAt: null }
  await api('alpha', endpoint, { actor: 'anonymous', expected: 401 })
  await api('alpha', endpoint, { actor: 'alpha-member', expected: 403 })
  await api('beta', endpoint, { expected: 404 })
  await api('alpha', endpoint, { method: 'POST', body: { ...value, endpoint: 'http://127.0.0.1' }, expected: 400 })
  const created = (await api('alpha', endpoint, { method: 'POST', body: value })).payload.connection
  const item = endpoint + '/' + created.id
  assert.equal(created.enabled, false)
  assert.equal(JSON.stringify(created).includes(token), false)
  const refreshed = (await api('alpha', item + '/refresh', { method: 'POST', body: {} })).payload.connection
  const connection = (await api('alpha', item, { method: 'PUT', body: { ...value, credential: undefined, enabled: true } })).payload.connection
  const metadata = (await api('alpha', root + '/tools?agentId=' + agent.id)).payload
  assert.ok(metadata.preview.tools.some(tool => tool.provenance?.connectionId === created.id))
  await api('alpha', root + '/tools', { actor: 'alpha-member', expected: 403 })
  await api('alpha', root + '/tools', { actor: 'anonymous', expected: 401 })
  await api('beta', root + '/tools', { expected: 404 })
  const originalRole = (await db.prepare('SELECT role_id FROM users WHERE id=?').bind(memberId).first()).role_id
  const personalRole = (await api('alpha', root + '/roles', { method: 'POST', body: { name: 'Personal tools fixture', permissions: Permission.useExternalTools | Permission.sendMessages } })).payload.role
  await db.prepare('UPDATE users SET role_id=? WHERE id=?').bind(personalRole.id,memberId).run()
  try {
    const personal = (await api('alpha', endpoint, { actor: 'alpha-member', method: 'POST', body: { ...value, name: 'Private connection fixture', ownership: 'member', grants: { agentIds: [agent.id], memberIds: [], roleIds: [] } } })).payload.connection
    await api('alpha', endpoint + '/' + personal.id + '/refresh', { actor: 'alpha-member', method: 'POST', body: {} })
    const privateAudit = (await api('alpha', root + '/tool-audit', { actor: 'alpha-member' })).payload
    assert.ok(privateAudit.entries.some(entry => entry.connectionId === personal.id))
    assert.ok(!(await api('alpha', root + '/tool-audit')).payload.entries.some(entry => entry.connectionId === personal.id))
    assert.ok(!(await api('alpha', root + '/audit')).payload.entries.some(entry => entry.action.startsWith('tool.connection.')))
    assert.ok(!(await api('alpha', root + '/agent-audit?view=changes&search=' + personal.id)).payload.entries.length)
    await api('alpha', endpoint + '/' + personal.id, { actor: 'alpha-member', method: 'DELETE' })
    assert.ok(!(await api('alpha', root + '/tool-audit')).payload.entries.some(entry => entry.connectionId === personal.id))
  } finally { await db.prepare('UPDATE users SET role_id=? WHERE id=?').bind(originalRole,memberId).run() }
  const schema = refreshed.tools[0]
  assert.equal(schema.remoteName, 'search_cloudflare_documentation')
  const saved = await db.prepare('SELECT credential_json FROM mcp_outbound_connections WHERE id=?').bind(created.id).first()
  assert.ok(saved.credential_json && !saved.credential_json.includes(token))
  const runId = crypto.randomUUID(), sessionId = crypto.randomUUID(), now = new Date().toISOString()
  await db.prepare('INSERT INTO agent_sessions(id,agent_id,channel_id,created_at,updated_at) VALUES(?,?,?,?,?)').bind(sessionId, agent.id, channelId, now, now).run()
  const mandate = JSON.stringify({ permissions, agentPermissions: permissions, computer: false, maxSteps: 20, maxModelCalls: 20, maxToolCalls: 100, maxTokens: 64000, toolConnections: [{ id: connection.id, revision: connection.revision }] })
  await db.prepare(`INSERT INTO agent_runs(id,session_id,agent_id,channel_id,initiated_by,idempotency_key,status,prompt,model,instructions,mandate_json,deadline,created_at,updated_at)
    VALUES(?,?,?,?,?,?,'running','Research docs','fixture','',?,?,?,?)`).bind(runId, sessionId, agent.id, channelId, owner, runId, mandate, new Date(Date.now() + 60000).toISOString(), now, now).run()
  const capability = createHmac('sha256', signingSecret).update('agent-run:' + runId).digest('hex')
  let count = 0
  const call = (name, args, expected = 200, callId = `external-${++count}`) => api('alpha', `/api/agent-runs/${runId}/gateway/tools`, { actor: 'anonymous', method: 'POST', headers: { Authorization: `Bearer ${capability}` }, body: { callId, name, arguments: args }, expected })
  try {
    const search = (await call('search_tools', { query: 'documentation' })).payload
    assert.ok(search.tools.some(tool => tool.name === schema.name))
    assert.equal(JSON.stringify(search).includes(token), false)
    const detail = (await call('get_tool_details', { name: schema.name, purpose: 'Cite public documentation' })).payload
    assert.equal(detail.tool.provenance.connectionId, created.id)
    const result = (await call(schema.name, { query: 'Durable Objects' }, 200, 'read-docs-once')).payload
    assert.ok(JSON.stringify(result).includes('Documentation evidence'))
    assert.equal(JSON.stringify(result).includes(token), false)
    assert.deepEqual((await call(schema.name, { query: 'Durable Objects' }, 200, 'read-docs-once')).payload, result)
    await api('alpha', endpoint, { method: 'POST', headers: { Authorization: `Bearer ${capability}` }, actor: 'anonymous', body: value, expected: 401 })
    await api('alpha', item, { method: 'PUT', body: { ...value, credential: undefined, enabled: false } })
    await call(schema.name, { query: 'Durable Objects' }, 403, 'read-docs-once')
    await call(schema.name, { query: 'Durable Objects' }, 403)
    assert.ok(!(await api('alpha', root + '/tools?agentId=' + agent.id)).payload.preview.tools.some(tool => tool.provenance?.connectionId === created.id))
    assert.equal((await db.prepare("SELECT count(*) AS n FROM audit_log WHERE action='tool.connection.call' AND target_id=?").bind(created.id).first()).n, 1)
    console.log('PASS: outbound MCP HTTP CRUD, real SDK/SSE, encrypted credentials, lazy discovery, broker read/ledger and revocation')
  } finally {
    await db.prepare("UPDATE agent_runs SET status='failed' WHERE id=?").bind(runId).run()
    await db.prepare("UPDATE agents SET status='paused' WHERE user_id=?").bind(agent.id).run()
  }
  // Leave one disabled connection for the full backup/restore assertion.
  return { connectionId: created.id, credentialJson: saved.credential_json, memberId }
}
