import { DatabaseSync } from 'node:sqlite'
import { execFileSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve, extname } from 'node:path'
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from 'miniflare'

const root = resolve(import.meta.dirname, '..')
const output = resolve(root, '.output/public')
const serverBundle = resolve(root, '.installer/bundle/index.js')
const installationBundle = resolve(root, 'apps/installation/.bundle/index.mjs')
const port = Number(process.env.LLLL_TEST_PORT || 18984)
const origin = `http://localhost:${port}`
const setupToken = 'local-integration-setup-claim-'.repeat(3)
const ownerPassword = 'LocalIntegrationPassword123!'
const keys = { alpha: 'alpha-integration-key-'.repeat(4), beta: 'beta-integration-key-'.repeat(4) }
const classes = { CHANNEL_DO: 'ChannelDurableObject', WORKSPACE_DO: 'WorkspaceDurableObject', RATE_LIMIT_DO: 'RateLimitDurableObject', NOTIFICATION_DO: 'NotificationDurableObject', AGENT_DO: 'L4Agent', AGENT_THINK: 'L4Think' }
const serve = process.argv.includes('--serve')

async function assets(request) {
  const url = new URL(request.url)
  const path = resolve(output, `.${decodeURIComponent(url.pathname)}`)
  if (!path.startsWith(`${output}/`) && path !== output) return new Response('Forbidden', { status: 403 })
  let data
  let extension = extname(path)
  try { data = await readFile(path) }
  catch { data = await readFile(resolve(output, 'index.html')); extension = '.html' }
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' }
  return new Response(data, { headers: { 'Content-Type': types[extension] || 'application/octet-stream' } })
}

const fixtureOptions = {
  host: '127.0.0.1', port, log: new Log(LogLevel.WARN),
  workers: [
    {
      name: 'installation', modules: true, scriptPath: installationBundle, compatibilityDate: '2026-09-26', compatibilityFlags: ['nodejs_compat'],
      d1Databases: { INSTALLATION_DB: 'installation-control' }, r2Buckets: { BACKUPS: 'fixture-backups' },
      bindings: { IDENTITY_PROVIDER: 'true', INSTALLATION_ID: 'integration', INSTALLATION_NAME: 'Integration', PUBLIC_ORIGIN: origin, AUTH_SECRET: 'integration-installation-secret-'.repeat(3), SETUP_TOKEN: setupToken, REGISTRATION_MODE: 'open', CLIENT_ORIGINS: origin },
      serviceBindings: { SERVER_ALPHA: 'server-alpha', SERVER_BETA: 'server-beta', ASSETS: assets },
    },
    ...['alpha', 'beta'].map((id, index) => ({
      name: `server-${id}`, modules: true, scriptPath: serverBundle, compatibilityDate: '2026-09-26', compatibilityFlags: ['nodejs_compat'],
      d1Databases: { DB: `server-${id}` }, r2Buckets: { FILES: `server-${id}-files`, BACKUPS: 'fixture-backups' }, kvNamespaces: { TICKETS: `server-${id}-tickets` },
      durableObjects: Object.fromEntries(Object.entries(classes).map(([binding, className]) => [binding, { className, useSQLite: true }])),
      serviceBindings: { INSTALLATION_SERVICE: 'installation' },
      bindings: { PUBLIC_ORIGIN: `http://localhost:${port + 1 + index}`, AUTH_SECRET: `${id}-server-auth-secret-`.repeat(3), ADMIN_EMAIL: 'owner@example.com', ADMIN_SETUP_TOKEN: 'integration-owner-claim-'.repeat(3), APP_NAME: id, ADMIN_WORKSPACE: id, AUTH_REGISTRATION_MODE: 'invite_only', LLLL_INSTALLATION_ORIGIN: origin, LLLL_SERVER_ID: id, LLLL_INSTALLATION_KEY: keys[id] },
    })),
  ],
}
const mf = new Miniflare(convertV4MiniflareOptions(fixtureOptions))

function execSql(sql) {
  return sql.split('--> statement-breakpoint').map(statement => statement.split('\n').filter(line => !line.trimStart().startsWith('--')).join(' ').replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n')
}

let ownerToken = ''
async function api(path, { method = 'GET', body, token = ownerToken, expected = 200 } = {}) {
  const response = await mf.dispatchFetch(origin + path, { method, headers: { Origin: origin, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) })
  const payload = await response.clone().json().catch(() => null)
  assert.equal(response.status, expected, `${method} ${path}: ${JSON.stringify(payload)}`)
  return { response, payload }
}

try {
  const control = await mf.getD1Database('INSTALLATION_DB', 'installation')
  await control.exec(execSql(await readFile(resolve(root, 'apps/installation/migrations/0000_installation_baseline.sql'), 'utf8')))
  const baseline = execSql(await readFile(resolve(root, 'drizzle/migrations/0000_server_baseline.sql'), 'utf8'))
  for (const id of ['alpha', 'beta']) await (await mf.getD1Database('DB', `server-${id}`)).exec(baseline)
  const setup = await api('/api/installation/setup', { method: 'POST', body: { token: setupToken, name: 'Owner', email: 'owner@example.com', password: ownerPassword } })
  ownerToken = setup.response.headers.get('set-auth-token')
  assert.ok(ownerToken, 'Better Auth must return a signed connection token')
  const ownerId = setup.payload.user.id
  for (const worker of fixtureOptions.workers.slice(1)) worker.bindings.LLLL_SERVER_OWNER_ID = ownerId
  await mf.setOptions(convertV4MiniflareOptions(fixtureOptions))
  for (const id of ['alpha', 'beta']) {
    await api('/api/installation/servers/register', { method: 'POST', expected: 201, body: { id, name: id, origin: `http://localhost:${id === 'alpha' ? port + 1 : port + 2}`, key: keys[id] } })
  }
  const directory = await api('/api/installation/servers')
  assert.deepEqual(directory.payload.servers.map(server => server.id), ['alpha', 'beta'])
  const [alpha, beta] = await Promise.all([api('/s/alpha/api/me'), api('/s/beta/api/me')])
  assert.equal(alpha.payload.user.id, ownerId)
  assert.equal(beta.payload.user.id, ownerId)
  for (const id of ['alpha', 'beta']) {
    const deletion = await api(`/s/${id}/api/workspaces/main/deletion`)
    assert.equal(deletion.payload.installationKind, 'manual')
    await api(`/s/${id}/api/workspaces/main/deletion`, { method: 'POST', body: {}, expected: 409 })
  }
  for (const id of ['alpha', 'beta']) {
    const db = await mf.getD1Database('DB', `server-${id}`)
    await db.prepare('UPDATE channels SET id = ? WHERE name = ?').bind(`${id}-general`, 'general').run()
  }
  const client = await api('/api/auth/oauth2/create-client', { method: 'POST', expected: 201, body: { client_name: 'Integration client', redirect_uris: ['https://client.example.com/callback'], token_endpoint_auth_method: 'client_secret_post' } })
  assert.ok(client.payload.client_id)
  const oidc = await api('/api/auth/.well-known/openid-configuration', { token: '' })
  assert.equal(oidc.payload.issuer, origin + '/api/auth')
  assert.ok(oidc.payload.jwks_uri)
  // Browser handoff binds a one-use code to its verifier and exact client.
  const verifier = 'local-browser-verifier-'.repeat(3)
  const challenge = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))).toString('base64url')
  const authorize = new URL('/api/auth/oauth2/authorize', origin)
  authorize.search = new URLSearchParams({ client_id: client.payload.client_id, redirect_uri: 'https://client.example.com/callback', response_type: 'code', scope: 'openid profile email', state: 'oidc-integration-state', nonce: 'oidc-integration-nonce', code_challenge: challenge, code_challenge_method: 'S256' }).toString()
  const anonymousAuthorization = await mf.dispatchFetch(authorize.toString(), { headers: { Accept: 'text/html', 'Sec-Fetch-Mode': 'navigate' }, redirect: 'manual' })
  assert.equal(anonymousAuthorization.status, 302, await anonymousAuthorization.clone().text())
  assert.equal(new URL(anonymousAuthorization.headers.get('location'), origin).pathname, '/connections')
  const authorization = await mf.dispatchFetch(authorize.toString(), { headers: { Accept: 'text/html', 'Sec-Fetch-Mode': 'navigate', Cookie: `llll-installation.session_token=${ownerToken}` }, redirect: 'manual' })
  assert.equal(authorization.status, 302, await authorization.clone().text())
  const consentUrl = new URL(authorization.headers.get('location'))
  assert.equal(consentUrl.pathname, '/consent')
  await api('/api/installation/consent?query=' + encodeURIComponent(consentUrl.search.slice(1)))
  const consent = await api('/api/auth/oauth2/consent', { method: 'POST', body: { accept: true, oauth_query: consentUrl.search.slice(1) } })
  const oidcCode = new URL(consent.payload.redirect_uri || consent.payload.url, origin).searchParams.get('code')
  assert.ok(oidcCode)
  const tokenResponse = await mf.dispatchFetch(origin + '/api/auth/oauth2/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', client_id: client.payload.client_id, client_secret: client.payload.client_secret, redirect_uri: 'https://client.example.com/callback', code: oidcCode, code_verifier: verifier }).toString() })
  assert.equal(tokenResponse.status, 200, await tokenResponse.clone().text())
  const oidcTokens = await tokenResponse.json()
  assert.ok(oidcTokens.id_token)
  const jwks = await api(new URL(oidc.payload.jwks_uri).pathname, { token: '' })
  const { createLocalJWKSet, jwtVerify } = await import('jose')
  const verified = await jwtVerify(oidcTokens.id_token, createLocalJWKSet(jwks.payload), { issuer: oidc.payload.issuer, audience: client.payload.client_id })
  assert.equal(verified.payload.sub, ownerId)
  assert.equal(verified.payload.nonce, 'oidc-integration-nonce')
  const handoff = await mf.dispatchFetch(origin + '/api/auth/connection/authorize?' + new URLSearchParams({ redirect_uri: origin + '/connections', state: 'local-browser-state-'.repeat(3), code_challenge: challenge }), { headers: { Origin: origin, Authorization: `Bearer ${ownerToken}` }, redirect: 'manual' })
  assert.equal(handoff.status, 302)
  const code = new URLSearchParams(new URL(handoff.headers.get('location')).hash.slice(1)).get('llll_connection')
  assert.ok(code)
  await api('/api/auth/connection/exchange', { method: 'POST', expected: 401, body: { code, code_verifier: 'wrong-local-verifier-'.repeat(3), redirect_uri: origin + '/connections' }, token: '' })
  const exchange = await api('/api/auth/connection/exchange', { method: 'POST', body: { code, code_verifier: verifier, redirect_uri: origin + '/connections' }, token: '' })
  assert.ok(exchange.response.headers.get('set-auth-token'))
  await api('/api/auth/connection/exchange', { method: 'POST', expected: 401, body: { code, code_verifier: verifier, redirect_uri: origin + '/connections' }, token: '' })
  const sent = await api('/s/alpha/api/channels/alpha-general/messages', { method: 'POST', body: { content: 'private alpha message', clientId: 'integration-message' } })
  assert.ok(sent.payload.message.id)
  await api('/s/beta/api/channels/alpha-general/messages', { expected: 404 })
  const betaMessages = await api('/s/beta/api/channels/beta-general/messages')
  assert.equal(betaMessages.payload.messages.length, 0)
  await api('/s/beta/api/messages/' + sent.payload.message.id, { method: 'PATCH', expected: 404, body: { content: 'cross-server edit' } })
  const form = new FormData()
  form.append('file', new File(['alpha attachment'], 'alpha.txt', { type: 'text/plain' }))
  const multipart = new Request(origin + '/s/alpha/api/channels/alpha-general/attachments', { method: 'POST', headers: { Origin: origin, Authorization: `Bearer ${ownerToken}` }, body: form })
  const upload = await mf.dispatchFetch(multipart.url, { method: 'POST', headers: multipart.headers, body: await multipart.arrayBuffer() })
  assert.equal(upload.status, 200, await upload.clone().text())
  const uploaded = await upload.json()
  const grant = directory.payload.servers.find(server => server.id === 'alpha').assetToken
  const file = await mf.dispatchFetch(origin + `/s/alpha/api/files/${uploaded.attachment.id}?llll_asset=${grant}`, { headers: { Origin: origin } })
  assert.equal(file.status, 200)
  assert.equal(await file.text(), 'alpha attachment')
  await api('/s/beta/api/files/' + uploaded.attachment.id, { expected: 404 })
  await api('/s/alpha/api/me?llll_asset=' + grant, { token: '', expected: 403 })
  async function socketAuthentication(serverId, token) {
    const response = await mf.dispatchFetch(origin + `/s/${serverId}/ws/workspace/main`, { headers: { Origin: origin, Upgrade: 'websocket' } })
    assert.equal(response.status, 101)
    const socket = response.webSocket
    socket.accept()
    const answer = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Socket authentication timed out')), 5000)
      socket.addEventListener('message', event => { clearTimeout(timer); resolve(JSON.parse(event.data)) }, { once: true })
      socket.addEventListener('close', () => { clearTimeout(timer); resolve({ t: 'closed' }) }, { once: true })
      socket.send(JSON.stringify({ t: 'auth', token }))
    })
    socket.close()
    return answer
  }
  const validSocketTicket = await api('/s/alpha/api/auth/ws-token', { method: 'POST', body: {} })
  assert.equal((await socketAuthentication('alpha', validSocketTicket.payload.token)).t, 'hello')
  const wrongServerTicket = await api('/s/alpha/api/auth/ws-token', { method: 'POST', body: {} })
  assert.notEqual((await socketAuthentication('beta', wrongServerTicket.payload.token)).t, 'hello')
  const connectionToken = exchange.response.headers.get('set-auth-token')
  const revokedTicket = await api('/s/alpha/api/auth/ws-token', { token: connectionToken, method: 'POST', body: {} })
  await api('/api/auth/sign-out', { token: connectionToken, method: 'POST', body: {} })
  assert.notEqual((await socketAuthentication('alpha', revokedTicket.payload.token)).t, 'hello')
  const serverBackup = await api('/s/alpha/api/workspaces/main/backup-to-bucket', { method: 'POST', body: {} })
  const installationBackup = await api('/api/installation/backup', { method: 'POST', body: {} })
  assert.ok(serverBackup.payload.sizeBytes > 0)
  assert.ok(installationBackup.payload.sizeBytes > 0)
  const backups = await mf.getR2Bucket('BACKUPS', 'installation')
  assert.ok(await backups.head(serverBackup.payload.key))
  assert.ok(await backups.head(installationBackup.payload.key))
  assert.notEqual(serverBackup.payload.key, installationBackup.payload.key)
  await mkdir(resolve(root, '.deployment/integration-backups'), { recursive: true })
  for (const [kind, snapshot] of [['server', serverBackup.payload], ['installation', installationBackup.payload]]) {
    const archive = resolve(root, `.deployment/integration-backups/${kind}.tar`)
    await writeFile(archive, new Uint8Array(await (await backups.get(snapshot.key)).arrayBuffer()), { mode: 0o600 })
    const entries = execFileSync('tar', ['-tf', archive], { encoding: 'utf8' }).trim().split('\n')
    assert.ok(entries.includes('summary.json'), 'A completed archive needs its final summary')
    const sqlFiles = entries.filter(name => /^database\/[0-9]{6}-(?:schema|indexes|[0-9]{6})\.sql$/.test(name)).sort()
    const restoredDb = new DatabaseSync(':memory:')
    restoredDb.exec('PRAGMA foreign_keys=ON; BEGIN;')
    restoredDb.exec(sqlFiles.map(name => execFileSync('tar', ['-xOf', archive, name], { encoding: 'utf8' })).join('\n'))
    restoredDb.exec('COMMIT;')
    assert.deepEqual(restoredDb.prepare('PRAGMA foreign_key_check').all(), [])
    if (kind === 'server') assert.equal(restoredDb.prepare('SELECT content FROM messages WHERE id = ?').get(sent.payload.message.id).content, 'private alpha message')
    else assert.equal(restoredDb.prepare('SELECT owner_id FROM installation_meta').get().owner_id, ownerId)
    restoredDb.close()
  }

  const bucketA = await mf.getR2Bucket('FILES', 'server-alpha')
  const bucketB = await mf.getR2Bucket('FILES', 'server-beta')
  await bucketA.put('same-key', 'alpha file')
  await bucketB.put('same-key', 'beta file')
  assert.equal(await (await bucketA.get('same-key')).text(), 'alpha file')
  assert.equal(await (await bucketB.get('same-key')).text(), 'beta file')
  const stranger = await api('/api/auth/sign-up/email', { method: 'POST', body: { name: 'Stranger', email: 'stranger@example.com', password: 'StrangerPassword123!' }, token: '' })
  const strangerToken = stranger.response.headers.get('set-auth-token')
  assert.ok(strangerToken)
  const strangerDirectory = await api('/api/installation/servers', { token: strangerToken })
  assert.deepEqual(strangerDirectory.payload.servers, [])
  await api('/s/alpha/api/me', { token: strangerToken, expected: 403 })
  await api('/api/installation/servers/register', { token: strangerToken, method: 'POST', expected: 403, body: { id: 'intruder', name: 'Intruder', origin: 'https://example.com', key: keys.alpha } })
  const invite = await api('/api/installation/servers/alpha/invites', { method: 'POST', body: {} })
  await api('/api/installation/join', { token: strangerToken, method: 'POST', body: { token: invite.payload.invite.token } })
  const admitted = await api('/s/alpha/api/me', { token: strangerToken })
  assert.equal(admitted.payload.user.id, stranger.payload.user.id)
  const ownerDirectoryAfterJoin = await api('/api/installation/servers')
  assert.deepEqual(ownerDirectoryAfterJoin.payload.servers.map(server => server.id), ['alpha', 'beta'], 'Each server appears once even when it has several members')
  const memberDirectory = await api('/api/installation/servers', { token: strangerToken })
  assert.deepEqual(memberDirectory.payload.servers.map(server => server.id), ['alpha'])
  await api('/s/beta/api/me', { token: strangerToken, expected: 403 })
  await api('/api/auth/sign-out', { token: strangerToken, method: 'POST', body: {} })
  await api('/s/alpha/api/me', { token: strangerToken, expected: 401 })
  fixtureOptions.workers[0].bindings.REGISTRATION_MODE = 'invite_only'
  await mf.setOptions(convertV4MiniflareOptions(fixtureOptions))
  await api('/api/auth/sign-up/email', { method: 'POST', token: '', expected: 400, body: { name: 'Blocked', email: 'blocked@example.com', password: ownerPassword } })
  const privateInvite = await api('/api/installation/servers/beta/invites', { method: 'POST', body: {} })
  const privateSignup = await api('/api/auth/sign-up/email', { method: 'POST', token: '', body: { name: 'Invited', email: 'invited@example.com', password: ownerPassword, inviteToken: privateInvite.payload.invite.token } })
  const invitedToken = privateSignup.response.headers.get('set-auth-token')
  const invitedDirectory = await api('/api/installation/servers', { token: invitedToken })
  assert.deepEqual(invitedDirectory.payload.servers.map(server => server.id), ['beta'])
  await api('/s/alpha/api/me', { token: invitedToken, expected: 403 })
  const recovery = await api('/api/installation/recovery-key', { method: 'POST', body: {} })
  await api('/api/installation/recover', { method: 'POST', token: '', expected: 401, body: { email: 'stranger@example.com', code: recovery.payload.code, password: ownerPassword } })
  await api('/api/installation/recover', { method: 'POST', token: '', body: { email: 'owner@example.com', code: recovery.payload.code, password: ownerPassword } })
  await api('/s/alpha/api/me', { expected: 401 })
  await api('/api/installation/recover', { method: 'POST', token: '', expected: 401, body: { email: 'owner@example.com', code: recovery.payload.code, password: ownerPassword } })
  const restored = await api('/api/auth/sign-in/email', { method: 'POST', token: '', body: { email: 'owner@example.com', password: ownerPassword } })
  ownerToken = restored.response.headers.get('set-auth-token')
  await api('/s/alpha/api/me')
  console.log('PASS: fresh installation auth, server directory, two runtime Workers, isolated D1 and R2, invitations, cross-server denial HTTP and WebSocket logout revocation, file grants, owner bootstrap, OIDC discovery and PKCE handoff')
  if (serve) {
    const { uuidv7 } = await import('uuidv7')
    const db = await mf.getD1Database('DB', 'server-alpha')
    const seeded = Array.from({ length: 600 }, (_, index) => db.prepare('INSERT INTO messages (id,channel_id,author_id,content,created_at) VALUES (?,?,?,?,?)').bind(uuidv7(), 'alpha-general', ownerId, `Timeline sample ${index + 1}\n${index % 7 === 0 ? 'A second line checks variable row heights.' : 'Community conversation.'}`, new Date().toISOString()))
    for (let offset = 0; offset < seeded.length; offset += 50) await db.batch(seeded.slice(offset, offset + 50))
    await mkdir(resolve(root, '.deployment'), { recursive: true })
    await writeFile(resolve(root, '.deployment/local-integration.json'), JSON.stringify({ origin, email: 'owner@example.com', password: ownerPassword, token: ownerToken }), { mode: 0o600 })
    console.log(`Local UI fixture: ${origin}/connections`)
    await new Promise(resolve => { process.once('SIGINT', resolve); process.once('SIGTERM', resolve) })
  }
}
finally { await mf.dispose() }
