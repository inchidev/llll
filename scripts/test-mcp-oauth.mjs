import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'

/** Real Worker HTTP routes, isolated D1, local Accounts and the MCP transport. */
export async function testMcpOAuth({ api, runtimes, origins, ids, cookies, memberId }) {
  const origin = origins.alpha
  const resource = `${origin}/mcp`
  const owner = (await api('alpha', '/api/me')).payload.user.id
  const db = await runtimes.alpha.getD1Database('DB')
  const mcpConnect = 1 << 12
  const defaults = (await api('alpha', `/api/servers/${ids.alpha}/roles`)).payload.roles
  for (const key of ['owner', 'admin', 'member']) {
    assert.equal(Boolean(defaults.find(role => role.key === key).permissions & mcpConnect), key === 'owner')
  }
  await db.prepare("INSERT INTO roles (id,key,name,permissions_bitmask) VALUES ('oauth-test-role','oauth-test','MCP test',?)").bind(768 | mcpConnect).run()
  // A Role's permissions are the policies assigned to it; toggling the grant swaps policies.
  const policy = async (name, permissions) => (await api('alpha', `/api/servers/${ids.alpha}/project-policies`, { method: 'POST', body: { name, permissions } })).payload.policy.id
  const [withConnect, withoutConnect] = [await policy('MCP test with connect', 768 | mcpConnect), await policy('MCP test without connect', 768)]
  const setConnectGrant = enabled => api('alpha', `/api/servers/${ids.alpha}/roles/oauth-test-role/policies`, {
    method: 'PUT', body: { policyIds: [enabled ? withConnect : withoutConnect] },
  })
  await setConnectGrant(true)
  await db.prepare("INSERT INTO users (id,kind,display_name,status,role_id,joined_at) VALUES ('oauth-test-agent','agent','OAuth test Agent','active','oauth-test-role',?)")
    .bind(new Date().toISOString()).run()

  const unauthenticated = await api('alpha', '/mcp', { actor: 'anonymous', expected: 401 })
  assert.match(unauthenticated.response.headers.get('www-authenticate'), /resource_metadata=/)
  const metadata = await api('alpha', '/.well-known/oauth-protected-resource/mcp', { actor: 'anonymous' })
  assert.equal(metadata.payload.resource, resource)
  const issuer = await api('alpha', '/.well-known/oauth-authorization-server/api/auth', { actor: 'anonymous' })
  assert.equal(issuer.payload.issuer, `${origin}/api/auth`)
  assert.deepEqual(issuer.payload.code_challenge_methods_supported, ['S256'])

  const registration = await api('alpha', '/api/auth/oauth2/register', { actor: 'anonymous', method: 'POST', expected: 201, body: {
    client_name: 'Integration MCP client', redirect_uris: ['http://127.0.0.1/callback'],
    token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
  } })
  const clientId = registration.payload.client_id
  const verifier = randomBytes(32).toString('base64url')
  const query = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: 'http://127.0.0.1:43871/callback',
    resource, scope: 'tasks:read tasks:write offline_access', state: 'worker-oauth-test',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' })

  async function begin(actor) {
    const response = await runtimes.alpha.dispatchFetch(`${origin}/api/auth/oauth2/authorize?${query}`, {
      // Node's fetch synthesizes Sec-Fetch-Mode from mode, overriding that header.
      // A navigation must not be represented as a browser CORS fetch to the provider.
      headers: { Host: new URL(origin).host, Cookie: cookies[actor] || '', Accept: 'text/html' }, mode: 'same-origin', redirect: 'manual',
    })
    assert.equal(response.status, 302, await response.clone().text())
    const url = new URL(response.headers.get('location'), origin)
    assert.equal(url.pathname, '/mcp/authorize')
    return url.search.slice(1)
  }
  const unsigned = await begin('anonymous')
  await api('alpha', `/api/mcp/consent?${new URLSearchParams({ oauth_query: unsigned })}`, { actor: 'anonymous', expected: 401 })
  const oauthQuery = await begin('alpha-owner')
  const consent = await api('alpha', `/api/mcp/consent?${new URLSearchParams({ oauth_query: oauthQuery })}`)
  assert.deepEqual(new Set(consent.payload.subjects.map(subject => subject.id)), new Set([owner, 'oauth-test-agent']))
  const consentPage = await runtimes.alpha.dispatchFetch(`${origin}/mcp/authorize?${oauthQuery}`)
  assert.match(consentPage.headers.get('content-security-policy'), /frame-ancestors 'none'/)
  const memberQuery = await begin('alpha-member')
  const memberConsent = await api('alpha', `/api/mcp/consent?${new URLSearchParams({ oauth_query: memberQuery })}`, { actor: 'alpha-member' })
  assert.deepEqual(memberConsent.payload.subjects, [], 'default members cannot connect MCP clients')
  await api('alpha', '/api/mcp/consent', { actor: 'alpha-member', method: 'POST', expected: 403,
    body: { accept: true, oauth_query: memberQuery, subjectId: 'oauth-test-agent', scopes: ['tasks:read'] } })
  await api('alpha', '/api/mcp/consent', { method: 'POST', expected: 403,
    headers: { Origin: 'https://attacker.example', 'x-llll-client': 'native' },
    body: { accept: true, oauth_query: oauthQuery, subjectId: owner, scopes: ['tasks:read'] } })
  const tampered = oauthQuery.replace('tasks%3Aread', 'documents%3Aread')
  await api('alpha', `/api/mcp/consent?${new URLSearchParams({ oauth_query: tampered })}`, { expected: 400 })
  await api('alpha', '/api/mcp/consent', { method: 'POST', expected: 403,
    body: { accept: true, oauth_query: oauthQuery, subjectId: memberId, scopes: ['tasks:read'] } })
  const approved = await api('alpha', '/api/mcp/consent', { method: 'POST', body: {
    accept: true, oauth_query: oauthQuery, subjectId: 'oauth-test-agent', scopes: ['tasks:read', 'tasks:write'],
  } })
  const callback = new URL(approved.payload.url)
  assert.equal(callback.searchParams.get('state'), 'worker-oauth-test')
  const code = callback.searchParams.get('code')
  assert.ok(code)

  async function token(form) {
    const response = await runtimes.alpha.dispatchFetch(`${origin}/api/auth/oauth2/token`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Host: new URL(origin).host },
      body: new URLSearchParams({ client_id: clientId, resource, ...form }).toString(),
    })
    return { response, payload: await response.json() }
  }
  const form = { grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: 'http://127.0.0.1:43871/callback' }
  const exchanged = await token(form)
  assert.equal(exchanged.response.status, 200, JSON.stringify(exchanged.payload))

  async function mcp(accessToken, name, args = {}, server = 'alpha') {
    const response = await runtimes[server].dispatchFetch(`${origins[server]}/mcp`, {
      method: 'POST', headers: { Host: new URL(origins[server]).host, Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    })
    const text = await response.text()
    const json = text.startsWith('event:') ? text.split('\ndata: ')[1]?.trim() : text
    return { response, payload: JSON.parse(json) }
  }
  const board = await api('alpha', `/api/servers/${ids.alpha}/boards`, { method: 'POST', body: { name: 'OAuth integration' } })
  const boardId = board.payload.board.id
  const created = await mcp(exchanged.payload.access_token, 'create_task', { boardId, title: 'OAuth integration task' })
  assert.equal(created.response.status, 200, JSON.stringify(created.payload))
  assert.ok(!created.payload.result.isError, JSON.stringify(created.payload))
  const task = JSON.parse(created.payload.result.content[0].text).task
  assert.equal(task.createdBy, 'oauth-test-agent')
  const audit = await db.prepare("SELECT actor_id,meta_json FROM audit_log WHERE action='task.create' AND target_id=?").bind(task.id).first()
  assert.equal(audit.actor_id, 'oauth-test-agent')
  assert.equal(JSON.parse(audit.meta_json).delegatedBy, owner)
  assert.equal(JSON.parse(audit.meta_json).clientId, clientId)
  // The connection was granted Task scopes only.
  assert.equal((await mcp(exchanged.payload.access_token, 'list_channels')).payload.result.isError, true)
  assert.equal((await mcp(exchanged.payload.access_token, 'list_task_boards', {}, 'beta')).response.status, 401)

  // Keep data permissions intact: removing only mcp.connect must block every
  // existing credential and fresh issuance, with no wait for token expiry.
  const manual = (await api('alpha', `/api/servers/${ids.alpha}/mcp-tokens`, { method: 'POST', body: {
    name: 'Grant removal test', subjectId: 'oauth-test-agent', scopes: ['tasks:read'],
  } })).payload.token
  assert.equal((await mcp(manual.token, 'list_task_boards')).response.status, 200)
  await setConnectGrant(false)
  assert.equal((await mcp(exchanged.payload.access_token, 'list_task_boards')).response.status, 401)
  assert.equal((await mcp(manual.token, 'list_task_boards')).response.status, 401)
  assert.equal((await token({ grant_type: 'refresh_token', refresh_token: exchanged.payload.refresh_token })).response.status, 400)
  await api('alpha', '/api/mcp/consent', { method: 'POST', expected: 403,
    body: { accept: true, oauth_query: oauthQuery, subjectId: 'oauth-test-agent', scopes: ['tasks:read'] } })
  await api('alpha', `/api/servers/${ids.alpha}/mcp-tokens`, { method: 'POST', expected: 403,
    body: { name: 'Denied without grant', subjectId: 'oauth-test-agent', scopes: ['tasks:read'] } })
  await setConnectGrant(true)

  const connections = (await api('alpha', '/api/mcp/connections')).payload.connections
  const connection = connections.find(item => item.subject.id === 'oauth-test-agent')
  assert.ok(connection)
  await api('alpha', `/api/mcp/connections/${connection.id}`, { actor: 'alpha-member', method: 'DELETE', expected: 404 })
  const refreshed = await token({ grant_type: 'refresh_token', refresh_token: exchanged.payload.refresh_token })
  assert.equal(refreshed.response.status, 200, JSON.stringify(refreshed.payload))
  await api('alpha', `/api/mcp/connections/${connection.id}`, { method: 'DELETE' })
  assert.equal((await mcp(refreshed.payload.access_token, 'list_task_boards')).response.status, 401)
  assert.equal((await token({ grant_type: 'refresh_token', refresh_token: refreshed.payload.refresh_token })).response.status, 400)
  // Code replay can revoke tokens issued by that code; test it after this connection's tool calls.
  assert.equal((await token(form)).response.status, 400, 'OAuth code replay must fail')

  const originalMemberRole = await db.prepare('SELECT role_id FROM users WHERE id=?').bind(memberId).first()
  await db.prepare("UPDATE users SET role_id='oauth-test-role' WHERE id=?").bind(memberId).run()
  const selfQuery = await begin('alpha-member')
  const selfConsent = await api('alpha', '/api/mcp/consent', { actor: 'alpha-member', method: 'POST', body: {
    accept: true, oauth_query: selfQuery, subjectId: memberId, scopes: ['tasks:read'],
  } })
  const selfTokens = await token({ ...form, code: new URL(selfConsent.payload.url).searchParams.get('code') })
  assert.equal(selfTokens.response.status, 200)
  assert.ok(!(await mcp(selfTokens.payload.access_token, 'list_task_boards')).payload.result.isError)
  await setConnectGrant(false)
  assert.equal((await mcp(selfTokens.payload.access_token, 'list_task_boards')).response.status, 401)
  assert.equal((await token({ grant_type: 'refresh_token', refresh_token: selfTokens.payload.refresh_token })).response.status, 400)
  const ownConnections = (await api('alpha', '/api/mcp/connections', { actor: 'alpha-member' })).payload.connections
  assert.equal(ownConnections.length, 1)
  assert.equal(ownConnections[0].subject.id, memberId)
  assert.ok(!(await api('alpha', '/api/mcp/connections')).payload.connections.some(item => item.id === ownConnections[0].id))
  await api('alpha', `/api/mcp/connections/${ownConnections[0].id}`, { actor: 'alpha-member', method: 'DELETE' })
  await db.prepare('UPDATE users SET role_id=? WHERE id=?').bind(originalMemberRole.role_id, memberId).run()
  console.log('PASS: MCP OAuth discovery/DCR, signed consent/CSRF, Agent authorship/audit, scope/server isolation, code replay, refresh, revocation and live Human/Agent mcp.connect removal for OAuth and bearer tokens')
}
