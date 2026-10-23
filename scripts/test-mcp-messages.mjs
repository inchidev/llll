import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'

/** Compare the real HTTP interface and MCP on the same isolated Worker/D1. */
export async function testMcpMessages({ api, runtimes, origins, ids, cookies, memberId }) {
  const origin = origins.alpha, resource = `${origin}/mcp`, root = `/api/servers/${ids.alpha}`
  const ownerId = (await api('alpha', '/api/me')).payload.user.id
  const db = await runtimes.alpha.getD1Database('DB')
  const originalRole = await db.prepare('SELECT role_id FROM users WHERE id=?').bind(memberId).first()
  const role = (await api('alpha', root + '/roles', { method: 'POST', body: { name: 'MCP chat only', permissions: 4096 } })).payload.role
  await api('alpha', root + '/members/' + memberId, { method: 'PATCH', body: { roleId: role.id } })
  const chat = (await api('alpha', root + '/channels', { method: 'POST', body: { name: 'mcp-chat' } })).payload.channel
  const hidden = (await api('alpha', root + '/channels', { method: 'POST', body: { name: 'mcp-private', visibility: 'private' } })).payload.channel
  const agentId = randomUUID()
  await db.prepare("INSERT INTO users(id,kind,display_name,status,role_id,joined_at) VALUES (?,'agent','MCP Mention Agent','active',?,?)")
    .bind(agentId, role.id, new Date().toISOString()).run()
  await db.prepare('INSERT INTO agents(user_id,created_by) VALUES (?,?)').bind(agentId, ownerId).run()
  const clientId = (await api('alpha', '/api/auth/oauth2/register', { actor: 'anonymous', method: 'POST', expected: 201, body: {
    client_name: 'Message integration', redirect_uris: ['http://127.0.0.1/callback'], token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
  } })).payload.client_id

  async function connect(actor, subjectId, scopes) {
    const verifier = randomBytes(32).toString('base64url')
    const query = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: 'http://127.0.0.1:43872/callback',
      resource, scope: [...scopes, 'offline_access'].join(' '), state: 'mcp-chat', code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' })
    const response = await runtimes.alpha.dispatchFetch(`${origin}/api/auth/oauth2/authorize?${query}`, {
      headers: { Host: new URL(origin).host, Cookie: cookies[actor], Accept: 'text/html' }, mode: 'same-origin', redirect: 'manual',
    })
    assert.equal(response.status, 302)
    const oauthQuery = new URL(response.headers.get('location'), origin).search.slice(1)
    const approved = (await api('alpha', '/api/mcp/consent', { actor, method: 'POST', body: { accept: true, oauth_query: oauthQuery, subjectId, scopes } })).payload
    const token = await runtimes.alpha.dispatchFetch(`${origin}/api/auth/oauth2/token`, { method: 'POST',
      headers: { Host: new URL(origin).host, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId, code: new URL(approved.url).searchParams.get('code'),
        redirect_uri: 'http://127.0.0.1:43872/callback', code_verifier: verifier, resource }).toString(),
    })
    assert.equal(token.status, 200, await token.clone().text())
    return (await token.json()).access_token
  }
  const token = await connect('alpha-member', memberId, ['messages:read', 'messages:write'])
  const readOnly = await connect('alpha-member', memberId, ['messages:read'])
  const ownerToken = await connect('alpha-owner', ownerId, ['messages:read', 'messages:write'])
  async function tool(token, name, args = {}) {
    const response = await runtimes.alpha.dispatchFetch(resource, { method: 'POST', headers: {
      Host: new URL(origin).host, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
    }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) })
    const text = await response.text(), payload = JSON.parse(text.startsWith('event:') ? text.split('\ndata: ')[1].trim() : text)
    return { status: response.status, error: payload.result?.isError, payload,
      value: !payload.result?.isError && payload.result?.content ? JSON.parse(payload.result.content[0].text) : null }
  }
  const override = (channelId, allow, deny) => api('alpha', `/api/channels/${channelId}/role-overrides/${role.id}`, { method: 'PUT', body: { allow, deny } })

  const discovery = (await tool(token, 'list_channels')).value.channels
  assert.ok(discovery.some(x => x.id === chat.id && x.canSend === false))
  assert.ok(!discovery.some(x => x.id === hidden.id))
  assert.ok(!(await tool(token, 'list_members')).value.members.some(x => x.kind === 'agent'))
  assert.ok((await tool(ownerToken, 'list_members', { kind: 'agent' })).value.members.some(x => x.id === agentId && x.mentionToken === `<@${agentId}>`))
  for (const name of ['list_messages', 'send_message']) {
    assert.equal((await tool(token, name, { channelId: hidden.id, content: 'Denied' })).error, true)
  }
  await api('alpha', `/api/channels/${hidden.id}/messages`, { actor: 'alpha-member', expected: 404 })
  await api('alpha', `/api/channels/${chat.id}/messages`, { actor: 'alpha-member', method: 'POST', expected: 403, body: { content: 'Denied' } })
  assert.equal((await tool(token, 'send_message', { channelId: chat.id, content: 'Denied' })).error, true)

  await override(chat.id, 16, 0)
  const sent = await tool(token, 'send_message', { channelId: chat.id, content: `MCP user message <@${agentId}>` })
  assert.ok(!sent.error, JSON.stringify(sent.payload))
  assert.equal(sent.value.message.author.id, memberId)
  assert.deepEqual(sent.value.message.mentions, [agentId])
  const inUi = (await api('alpha', `/api/channels/${chat.id}/messages`, { actor: 'alpha-member' })).payload.messages
  assert.ok(inUi.some(x => x.id === sent.value.message.id && x.author.id === memberId))
  await api('alpha', `/api/channels/${chat.id}/messages`, { actor: 'alpha-member', method: 'POST', body: { content: 'Interface user message' } })
  const history = (await tool(token, 'list_messages', { channelId: chat.id, limit: 1 })).value
  assert.equal(history.messages[0].content, 'Interface user message')
  assert.ok(history.nextCursor)
  assert.equal((await tool(token, 'list_messages', { channelId: chat.id, cursor: history.nextCursor })).value.messages[0].id, sent.value.message.id)
  const audit = await db.prepare("SELECT actor_id,meta_json FROM audit_log WHERE action='message.create' AND target_id=?").bind(sent.value.message.id).first()
  assert.equal(audit.actor_id, memberId)
  assert.equal(JSON.parse(audit.meta_json).clientId, clientId)
  assert.equal((await tool(readOnly, 'send_message', { channelId: chat.id, content: 'Denied by scope' })).error, true)
  assert.equal((await tool(token, 'list_documents')).error, true)
  assert.equal((await tool(token, 'create_task', { boardId: 'irrelevant-board', title: 'Denied' })).error, true)
  assert.equal((await tool(token, 'send_message', { channelId: chat.id, content: 'Invalid reply', replyToId: 'missing-message' })).error, true)

  const thread = (await api('alpha', `/api/channels/${chat.id}/threads`, { method: 'POST', body: { messageId: sent.value.message.id } })).payload.channel
  assert.ok(!(await tool(token, 'send_message', { channelId: thread.id, content: 'MCP thread reply' })).error)
  await override(chat.id, 0, 16)
  assert.equal((await tool(token, 'send_message', { channelId: thread.id, content: 'Denied by parent' })).error, true)
  await api('alpha', `/api/channels/${thread.id}/messages`, { actor: 'alpha-member', method: 'POST', expected: 403, body: { content: 'Denied by parent' } })
  assert.ok(!(await tool(token, 'list_messages', { channelId: thread.id })).error)
  const dm = (await api('alpha', '/api/dms', { actor: 'alpha-member', method: 'POST', body: { userId: ownerId } })).payload.channel
  assert.ok(!(await tool(token, 'send_message', { channelId: dm.id, content: 'DM works without global send' })).error)

  // Agent and human DMs share channel navigation's thread query and access boundary.
  const agentDm = (await api('alpha', '/api/dms', { method: 'POST', body: { userId: agentId } })).payload.channel
  const rootMessageId = randomUUID(), agentThreadId = randomUUID(), replyId = randomUUID(), at = new Date().toISOString()
  await db.prepare("INSERT INTO messages(id,channel_id,author_id,content,created_at) VALUES (?,?,?,'Plan the next steps',?)").bind(rootMessageId, agentDm.id, ownerId, at).run()
  await db.prepare("INSERT INTO channels(id,name,type,visibility,parent_id,parent_message_id,created_at,updated_at) VALUES (?,'Plan the next steps','thread','private',?,?,?,?)").bind(agentThreadId, agentDm.id, rootMessageId, at, at).run()
  await db.prepare("INSERT INTO messages(id,channel_id,author_id,content,created_at) VALUES (?,?,?,'Here is the plan',?)").bind(replyId, agentThreadId, agentId, at).run()
  const ownerDms = (await api('alpha', '/api/dms')).payload
  assert.ok(ownerDms.threads.some(t => t.id === agentThreadId && t.parentId === agentDm.id))
  assert.ok(!(await api('alpha', '/api/dms', { actor: 'alpha-member' })).payload.threads.some(t => t.id === agentThreadId))
  const channelsNav = (await api('alpha', root + '/channels')).payload
  assert.ok(!channelsNav.threads.some(t => t.id === agentThreadId))
  assert.ok(channelsNav.threads.some(t => t.id === thread.id))

  await api('alpha', root + '/roles/' + role.id, { method: 'PATCH', body: { permissions: 16 } })
  assert.equal((await tool(token, 'list_messages', { channelId: chat.id })).status, 401)
  await api('alpha', root + '/members/' + memberId, { method: 'PATCH', body: { roleId: originalRole.role_id } })
  console.log('PASS: MCP chat-only OAuth, interface permission parity, private discovery/history, channel overrides, DM/thread access, mentions, persisted user authorship/audit, scope separation and live grant removal')
}
