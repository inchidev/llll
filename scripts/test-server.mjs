import { testFactoryTransport } from './test-factory-transport.mjs'
import { githubSetupFixture, testGitConnections } from './test-git-connections.mjs'
import { testProjects } from './test-projects.mjs'
import { testRunPublication } from './test-run-publication.mjs'
import { createHash } from 'node:crypto'
import { Miniflare, convertV4MiniflareOptions, Log, LogLevel } from 'miniflare'
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises'
import { resolve, extname } from 'node:path'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { execFileSync } from 'node:child_process'
import { testMcpOAuth } from './test-mcp-oauth.mjs'
import { testMcpMessages } from './test-mcp-messages.mjs'
import { testAgentRoles } from './test-agent-roles.mjs'
import { testRoleManagement } from './test-role-management.mjs'
import { testGadgetAuthorization } from './test-gadget-authorization.mjs'
import { testInbox } from './test-inbox.mjs'
import { testInboundMail } from './test-inbound-mail.mjs'
import { testAgentBudget } from './test-agent-budget.mjs'
import { testAgentToolDiscovery } from './test-agent-tool-discovery.mjs'
import { outboundMcpFixture, testOutboundMcp } from './test-outbound-mcp.mjs'
const root = resolve(import.meta.dirname, '..')
const port = Number(process.env.LLLL_TEST_PORT || 18984)
const basicStorage = process.argv.includes('--basic')
const password = 'LocalServerIntegrationPassword123!'
const setup = 'local-owner-claim-'.repeat(4)
const classes = {
  CHANNEL_DO: 'ChannelDurableObject',
  SERVER_DO: 'ServerDurableObject',
  RATE_LIMIT_DO: 'RateLimitDurableObject',
  NOTIFICATION_DO: 'NotificationDurableObject',
  AGENT_DO: 'L4Agent',
}
const origins = {
  alpha: `http://127.0.0.1:${port}`,
  beta: `http://127.0.0.1:${port + 1}`,
}
const runtimes = {}
const cookies = {}
const ids = {}
async function assets(request) {
  const url = new URL(request.url)
  let path = resolve(
    root,
    '.output/public',
    '.' + decodeURIComponent(url.pathname),
  )
  // Like Cloudflare Static Assets with html_handling none: documents come from the Worker.
  if (!path.startsWith(resolve(root, '.output/public') + '/')) return new Response('Not found', { status: 404 })
  let data
  const extension = extname(path)
  try {
    data = await readFile(path)
  } catch {
    return new Response('Not found', { status: 404 })
  }
  return new Response(data, {
    headers: {
      'Content-Type':
        {
          '.html': 'text/html',
          '.js': 'application/javascript',
          '.css': 'text/css',
          '.json': 'application/json',
          '.png': 'image/png',
          '.svg': 'image/svg+xml',
          '.woff2': 'font/woff2',
        }[extension] || 'application/octet-stream',
    },
  })
}
function sql(text) {
  return text
    .split('--> statement-breakpoint')
    .map((s) =>
      s
        .split('\n')
        .filter((l) => !l.trimStart().startsWith('--'))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .filter(Boolean)
    .join('\n')
}
async function api(
  server,
  path,
  {
    method = 'GET',
    body,
    actor = server + '-owner',
    expected = 200,
    redirect = 'follow',
    headers = {},
  } = {},
) {
  const response = await runtimes[server].dispatchFetch(
    origins[server] + path,
    {
      method,
      redirect,
      headers: {
        Host: new URL(origins[server]).host,
        Origin: origins[server],
        Cookie: cookies[actor] || '',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
  )
  for (const cookie of response.headers.getSetCookie()) {
    const pair = cookie.split(';')[0]
    if (pair.includes('session_token=')) cookies[actor] = pair
  }
  const payload = await response
    .clone()
    .json()
    .catch(() => null)
  assert.equal(
    response.status,
    expected,
    `${server} ${method} ${path}: ${JSON.stringify(payload)}`,
  )
  return { response, payload }
}
try {
  for (const [index, name] of ['alpha', 'beta'].entries()) {
    runtimes[name] = new Miniflare(
      convertV4MiniflareOptions({
        host: '127.0.0.1',
        port: port + index,
        log: new Log(LogLevel.WARN),
        workers: [
          {
            name: 'server-' + name,
            modules: true,
            scriptPath: resolve(root, '.installer/bundle/index.js'),
            compatibilityDate: '2026-09-26',
            compatibilityFlags: [
              'nodejs_compat',
              'global_fetch_strictly_public',
            ],
            d1Databases: { DB: name },
            r2Buckets: basicStorage ? {} : { FILES: name + '-files', BACKUPS: name + '-backups' },
            kvNamespaces: { TICKETS: name + '-tickets' },
            durableObjects: Object.fromEntries(
              Object.entries(classes).map(([binding, className]) => [
                binding,
                { className, useSQLite: true },
              ]),
            ),
            serviceBindings: { ASSETS: assets },
            outboundService: async request => {
              const git = await githubSetupFixture(request)
              if (git) return git
              const mcp = await outboundMcpFixture(request)
              if (mcp) return mcp
              const url = new URL(request.url)
              if (url.hostname === 'api.github.com' && url.pathname === '/repos/inchidev/llll/releases') return Response.json([{
                tag_name: 'v0.3.0', published_at: '2026-10-21T00:00:00Z', html_url: 'https://github.com/inchidev/llll/releases/tag/v0.3.0',
                assets: ['llll-release.json', 'llll-cloudflare-manifest.json', 'llll-worker.mjs', 'llll-assets.json', 'SHA256SUMS'].map(name => ({ name })),
              }])
              return fetch(request)
            },
            bindings: {
              PUBLIC_ORIGIN: origins[name],
              LLLL_ACCOUNT_ID: 'a'.repeat(32),
              LLLL_WORKER_NAME: 'server-' + name,
              LLLL_SERVER_MARKER: 'llll.gg/server-v1',
              LLLL_VERSION: '0.2.0-alpha.8',
              ...(basicStorage ? {} : { BACKUP_BUCKET_NAME: name + '-backups' }),
              AUTH_SECRET: (name + '-server-secret-').repeat(4),
              INBOUND_EMAIL_SECRET: (name + '-inbound-secret-').repeat(4),
              APP_NAME: name,
              ADMIN_EMAIL: 'owner@example.com',
              SETUP_TOKEN: setup,
              AUTH_REGISTRATION_MODE: 'invite_only',
              EMBED_ORIGINS: 'http://localhost:19003',
            },
          },
        ],
      }),
    )
    const db = await runtimes[name].getD1Database('DB')
    for (const path of ['/', '/agents', '/channels', '/app-shell']) {
      const page = await runtimes[name].dispatchFetch(origins[name] + path, { headers: { 'User-Agent': 'TelegramBot' } })
      const html = await page.text()
      assert.equal(page.status, 200)
      assert.match(html, /<meta property="og:description" content="One workspace for humans and agents\."/)
      assert.doesNotMatch(html, /Chat that lives on your Cloudflare account/)
    }
    for (const file of (await readdir(resolve(root, 'drizzle/server-migrations')))
      .filter((n) => n.endsWith('.sql'))
      .sort())
      await db.exec(
        sql(await readFile(resolve(root, 'drizzle/server-migrations', file), 'utf8')),
      )
    const discovery = await api(name, '/.well-known/llll', {
      actor: 'anonymous',
    })
    ids[name] = discovery.payload.id
    assert.match(
      ids[name],
      /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
    )
    assert.equal(discovery.payload.kind, 'server')
    assert.equal(discovery.payload.apiVersion, 2)
    await api(name, '/api/unknown-endpoint', { expected: 404 })
    await api(name, '/api/workspaces', { expected: 404 })
    assert.equal(discovery.payload.ready, false)
    const initialManifest = (await api(name, '/pwa/manifest.webmanifest', { actor: 'anonymous' })).payload
    assert.equal(initialManifest.id, '/')
    assert.ok(initialManifest.icons.some(icon => icon.src === '/android-chrome-192x192.png'))
    await api(name, '/api/setup/owner', {
      method: 'POST',
      body: { token: setup, name: 'Owner', password },
    })
    assert.ok(
      cookies[name + '-owner'],
      'Owner setup must establish a local session',
    )
    const initialPush = await api(name, '/api/push/config')
    assert.deepEqual(initialPush.payload, { configured: true, publicKey: null })
    await api(name, '/api/push/config', { method: 'POST', actor: 'anonymous', expected: 401 })
    const push = (await api(name, '/api/push/config', { method: 'POST' })).payload
    assert.equal(push.configured, true)
    assert.match(push.publicKey, /^[A-Za-z0-9_-]{87}$/)
    assert.deepEqual(Object.keys(push).sort(), ['configured', 'publicKey'])
    assert.deepEqual((await api(name, '/api/push/config')).payload, push)
    assert.deepEqual((await api(name, '/api/push/config', { method: 'POST' })).payload, push)
    const home = await api(name, '/api/server')
    assert.equal(home.payload.server.id, ids[name])
    assert.equal((await api(name, '/.well-known/llll')).payload.id, ids[name])
    assert.equal((await api(name, '/.well-known/llll')).payload.ready, true)
    await api(name, `/api/servers/${ids[name]}`, { method: 'PATCH', body: { name: 'Renamed ' + name } })
    assert.equal((await api(name, '/.well-known/llll', { actor: 'anonymous' })).payload.name, 'Renamed ' + name)
    assert.equal((await api(name, '/api/setup/health', { actor: 'anonymous' })).payload.appName, 'Renamed ' + name)
    assert.equal((await api(name, '/.well-known/llll', { actor: 'anonymous' })).payload.version, '0.2.0-alpha.8')
    assert.equal((await api(name, '/api/setup/health', { actor: 'anonymous' })).payload.version, '0.2.0-alpha.8')
    await api(name, `/api/servers/${ids[name]}/icon`, { actor: 'anonymous', expected: 401 })
    await api(name, '/.well-known/llll/icon', { actor: 'anonymous', expected: 404 })
    let previousIconUrl = ''
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jGL8AAAAASUVORK5CYII=', 'base64')
    for (const bytes of [png, Buffer.concat([png, Buffer.from([0])])]) {
      const iconForm = new FormData()
      iconForm.append('file', new File([bytes], 'icon.png', { type: 'image/png' }))
      const uploadRequest = new Request(origins[name] + `/api/servers/${ids[name]}/icon`, { method: 'PUT', headers: { Host: new URL(origins[name]).host, Origin: origins[name], Cookie: cookies[name + '-owner'] }, body: iconForm })
      const uploaded = await runtimes[name].dispatchFetch(uploadRequest.url, { method: 'PUT', headers: uploadRequest.headers, body: await uploadRequest.arrayBuffer() })
      assert.equal(uploaded.status, 200, await uploaded.clone().text())
      const appearance = (await api(name, '/.well-known/llll', { actor: 'anonymous' })).payload
      assert.ok(appearance.iconUrl.startsWith(origins[name] + '/.well-known/llll/icon?v='))
      assert.notEqual(appearance.iconUrl, previousIconUrl)
      previousIconUrl = appearance.iconUrl
      const publicIcon = await api(name, new URL(appearance.iconUrl).pathname + new URL(appearance.iconUrl).search, { actor: 'anonymous' })
      const manifest = (await api(name, '/pwa/manifest.webmanifest', { actor: 'anonymous' })).payload
      assert.equal(manifest.name, 'Renamed ' + name)
      assert.equal(manifest.icons[0].src, appearance.iconUrl)
      const touchIcon = await api(name, '/pwa/icon', { actor: 'anonymous', redirect: 'manual', expected: 302 })
      assert.equal(touchIcon.response.headers.get('location'), appearance.iconUrl)
      assert.deepEqual(Buffer.from(await publicIcon.response.arrayBuffer()), bytes)
      assert.equal(publicIcon.response.headers.get('content-type'), 'image/png')
    }
    await api(name, `/api/servers/${ids[name]}/icon`, { method: 'DELETE' })
    assert.equal((await api(name, '/.well-known/llll', { actor: 'anonymous' })).payload.iconUrl, null)
    const fallbackManifest = (await api(name, '/pwa/manifest.webmanifest', { actor: 'anonymous' })).payload
    assert.ok(fallbackManifest.icons.some(icon => icon.src === '/android-chrome-192x192.png'))
    assert.equal((await api(name, '/pwa/icon', { actor: 'anonymous', redirect: 'manual', expected: 302 })).response.headers.get('location'), '/apple-touch-icon.png')
    await api(name, '/.well-known/llll/icon', { actor: 'anonymous', expected: 404 })
    await api(name, '/api/servers/main/members', { expected: 404 })
    const page = await api(name, '/login', { actor: 'anonymous' })
    assert.ok(
      page.response.headers
        .get('content-security-policy')
        .includes('https://llll.gg'),
    )
    assert.notEqual(page.response.headers.get('x-frame-options'), 'DENY')
    const cors = await api(name, '/.well-known/llll', {
      headers: { Origin: 'http://localhost:19003' },
    })
    assert.equal(
      cors.response.headers.get('access-control-allow-origin'),
      'http://localhost:19003',
    )
  }
  assert.notEqual(ids.alpha, ids.beta)
  if (basicStorage) {
    const storage = (await api('alpha', `/api/servers/${ids.alpha}/storage`)).payload
    assert.equal(storage.backend, 'kv'); assert.equal(storage.r2Available, false)
    const general = (await api('alpha', `/api/servers/${ids.alpha}/channels`)).payload.channels.find(channel => channel.type === 'text')
    const form = new FormData(); form.append('file', new File(['private basic attachment'], 'basic.txt', { type: 'text/plain' }))
    const request = new Request(origins.alpha + `/api/channels/${general.id}/attachments`, { method: 'POST', headers: { Origin: origins.alpha, Cookie: cookies['alpha-owner'] }, body: form })
    const uploaded = await runtimes.alpha.dispatchFetch(request.url, { method: 'POST', headers: request.headers, body: await request.arrayBuffer() })
    assert.equal(uploaded.status, 200, await uploaded.clone().text())
    const attachment = (await uploaded.json()).attachment
    assert.equal(await (await api('alpha', '/api/files/' + attachment.id)).response.text(), 'private basic attachment')
    await api('alpha', '/api/files/' + attachment.id, { actor: 'anonymous', expected: 401 })
    const requestId = crypto.randomUUID()
    await api('alpha', `/api/servers/${ids.alpha}/updates/request`, { method: 'POST', body: { requestId, release: 'v0.3.0' } })
    const backup = await api('alpha', `/api/servers/${ids.alpha}/backup?update=${requestId}`, { method: 'POST' })
    const bytes = Buffer.from(await backup.response.arrayBuffer())
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    await api('alpha', `/api/servers/${ids.alpha}/updates/downloaded`, { method: 'POST', body: { requestId, sha256: '0'.repeat(64), sizeBytes: bytes.length }, expected: 409 })
    await api('alpha', `/api/servers/${ids.alpha}/updates/downloaded`, { method: 'POST', body: { requestId, sha256, sizeBytes: bytes.length } })
    const archive = resolve(root, '.deployment/integration/basic.tar')
    await mkdir(resolve(root, '.deployment/integration'), { recursive: true }); await writeFile(archive, bytes, { mode: 0o600 })
    const entries = execFileSync('tar', ['-tf', archive], { encoding: 'utf8' }).trim().split('\n')
    const restored = new DatabaseSync(':memory:'); restored.exec('PRAGMA foreign_keys=ON; BEGIN;')
    restored.exec(entries.filter(name => /^database\/[0-9]{6}-(?:schema|indexes|[0-9]{6})\.sql$/.test(name)).sort().map(name => execFileSync('tar', ['-xOf', archive, name], { encoding: 'utf8' })).join('\n'))
    restored.exec('COMMIT;'); assert.deepEqual(restored.prepare('PRAGMA foreign_key_check').all(), [])
    assert.equal(restored.prepare('SELECT id FROM server_identity').get().id, ids.alpha)
    assert.ok(restored.prepare('SELECT COUNT(*) AS n FROM file_objects').get().n > 0)
    const restoredKey = restored.prepare('SELECT r2_key FROM attachments WHERE id=?').get(attachment.id).r2_key
    const payloads = new Map(entries.filter(name => /^r2\/[0-9]+\.json$/.test(name)).map(name => {
      const metadata = JSON.parse(execFileSync('tar', ['-xOf', archive, name], { encoding: 'utf8' }))
      return [metadata.key, execFileSync('tar', ['-xOf', archive, name.replace(/\.json$/, '.bin')])]
    }))
    const { fileStorage } = await import('../shared/file-storage.ts')
    const { d1 } = await import('../tests/helpers/sqlite-d1.ts')
    const restoredFiles = fileStorage({
      DB: d1(restored),
      TICKETS: { get: async () => { throw new Error('The original KV namespace is unavailable after restore') } },
      FILES: { get: async key => { const bytes = payloads.get(key); return bytes ? { text: async () => bytes.toString() } : null } },
    })
    assert.equal(await (await restoredFiles.get(restoredKey)).text(), 'private basic attachment')
    restored.close()
    console.log('PASS: KV-only Servers, icon and attachment read/write/authorization, downloaded backup digest rejection/confirmation and UUID-preserving SQL restore')
    if (process.argv.includes('--serve')) {
      console.log(`Basic storage Servers: ${origins.alpha}, ${origins.beta}`)
      await new Promise(resolve => { process.once('SIGINT', resolve); process.once('SIGTERM', resolve) })
    }
  } else {
  await api('beta', '/api/me', { actor: 'alpha-owner', expected: 401 })
  await api('alpha', '/api/me', {
    actor: 'anonymous',
    expected: 401,
    headers: { 'x-llll-identity': 'forged-server-identity' },
  })
  const channels = await api('alpha', `/api/servers/${ids.alpha}/channels`)
  const general = channels.payload.channels.find((c) => c.name === 'general')
  assert.ok(general)
  const invite = await api('alpha', `/api/servers/${ids.alpha}/invites`, {
    method: 'POST',
    body: { maxUses: 2 },
  })
  const signup = await api('alpha', '/api/auth/signup', {
    actor: 'alpha-member',
    method: 'POST',
    body: {
      name: 'Member',
      email: 'member@example.com',
      password,
      inviteCode: invite.payload.invite.code,
      accepted: true,
    },
  })
  const memberId = signup.payload.user.id
  await api('alpha', `/api/invites/${invite.payload.invite.code}/accept`, {
    actor: 'alpha-member',
    method: 'POST',
    body: {},
  })
  await testInboundMail({ runtimes, origins, signingSecret: ('alpha-inbound-secret-').repeat(4) })
  await testAgentBudget({ api, runtimes, ids, signingSecret: ('alpha-server-secret-').repeat(4), channelId: general.id })
  await testAgentToolDiscovery({ api, runtimes, ids, signingSecret: ('alpha-server-secret-').repeat(4), channelId: general.id })
  const outboundMcp = await testOutboundMcp({ api, runtimes, ids, signingSecret: ('alpha-server-secret-').repeat(4), channelId: general.id, memberId })
  const publication = await testRunPublication({ api, runtimes, ids, channelId: general.id })
  await testFactoryTransport({ api })
  const gitFixture = await testGitConnections({ api, runtimes, ids })
  const projectFixture = await testProjects({ api, runtimes, ids, memberId })
  await testRoleManagement({ api, runtimes, ids, memberId })
  await testAgentRoles({ api, runtimes, ids, memberId })
  await testGadgetAuthorization({ api, runtimes, ids, memberId })
  await testMcpOAuth({ api, runtimes, origins, ids, cookies, memberId })
  await testMcpMessages({ api, runtimes, origins, ids, cookies, memberId })
  const recoveryDb = await runtimes.alpha.getD1Database('DB')
  const ownerId = (await recoveryDb.prepare('SELECT owner_id FROM server').first()).owner_id
  const orphanId = crypto.randomUUID()
  await recoveryDb.batch([
    recoveryDb.prepare("INSERT INTO channels(id,name,type,visibility) VALUES(?,'legacy-private','text','private')").bind(orphanId),
    recoveryDb.prepare('INSERT INTO channel_members(channel_id,user_id,joined_at) VALUES(?,?,?)').bind(orphanId, memberId, new Date().toISOString()),
  ])
  await api('alpha', `/api/servers/${ids.alpha}/channels/recovery`, { actor: 'alpha-member', expected: 403 })
  const recoverable = await api('alpha', `/api/servers/${ids.alpha}/channels/recovery`)
  assert.ok(recoverable.payload.channels.some(channel => channel.id === orphanId))
  const candidates = await api('alpha', `/api/servers/${ids.alpha}/channels/${orphanId}/creator`)
  assert.deepEqual(candidates.payload.members.map(member => member.id), [memberId])
  await api('alpha', `/api/servers/${ids.alpha}/channels/${orphanId}/creator`, { method: 'PUT', body: { userId: ownerId }, expected: 409 })
  await api('alpha', `/api/servers/${ids.alpha}/channels/${orphanId}/creator`, { method: 'PUT', body: { userId: memberId } })
  await api('alpha', `/api/servers/${ids.alpha}/channels/${orphanId}/creator`, { method: 'PUT', body: { userId: memberId }, expected: 409 })
  await api('alpha', `/api/channels/${orphanId}/members`, { expected: 404 })
  await api('alpha', `/api/channels/${orphanId}/members`, { actor: 'alpha-member' })
  assert.equal((await recoveryDb.prepare("SELECT count(*) AS n FROM audit_log WHERE target_id=? AND action='channel.creator.assign'").bind(orphanId).first()).n, 1)
  console.log('PASS: owner explicitly recovers a missing creator without gaining channel access; only the chosen participant manages membership')
  const sent = await api('alpha', `/api/channels/${general.id}/messages`, {
    actor: 'alpha-member',
    method: 'POST',
    body: { content: 'Standalone alpha message' },
  })
  assert.equal(sent.payload.message.serverId, ids.alpha)
  await api('beta', `/api/channels/${general.id}/messages`, { expected: 404 })
  const form = new FormData()
  form.append(
    'file',
    new File(['private alpha attachment'], 'alpha.txt', { type: 'text/plain' }),
  )
  const multipart = new Request(
    origins.alpha + `/api/channels/${general.id}/attachments`,
    {
      method: 'POST',
      headers: {
        Host: new URL(origins.alpha).host,
        Origin: origins.alpha,
        Cookie: cookies['alpha-owner'],
      },
      body: form,
    },
  )
  const upload = await runtimes.alpha.dispatchFetch(multipart.url, {
    method: 'POST',
    headers: multipart.headers,
    body: await multipart.arrayBuffer(),
  })
  assert.equal(upload.status, 200, await upload.clone().text())
  const attachment = (await upload.json()).attachment
  const file = await api('alpha', '/api/files/' + attachment.id)
  assert.equal(await file.response.text(), 'private alpha attachment')
  await api('alpha', '/api/files/' + attachment.id, {
    actor: 'anonymous',
    expected: 401,
  })
  await api('beta', '/api/files/' + attachment.id, { expected: 404 })
  async function socketAuth(server, ticket) {
    const response = await runtimes[server].dispatchFetch(
      origins[server] + `/ws/server/${ids[server]}`,
      { headers: { Upgrade: 'websocket' } },
    )
    assert.equal(response.status, 101)
    const socket = response.webSocket
    socket.accept()
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Socket authentication timeout')),
        5000,
      )
      socket.addEventListener(
        'message',
        (e) => {
          clearTimeout(timer)
          resolve(JSON.parse(e.data))
        },
        { once: true },
      )
      socket.addEventListener(
        'close',
        () => {
          clearTimeout(timer)
          resolve({ t: 'closed' })
        },
        { once: true },
      )
      socket.send(JSON.stringify({ t: 'auth', token: ticket }))
    })
    socket.close()
    return result
  }
  async function heldSocket(path, actor = 'alpha-owner') {
    const ticket = await api('alpha', '/api/auth/ws-token', { actor, method: 'POST', body: {} })
    const response = await runtimes.alpha.dispatchFetch(origins.alpha + path, { headers: { Upgrade: 'websocket' } })
    assert.equal(response.status, 101)
    const socket = response.webSocket
    socket.accept()
    const messages = []
    const closed = new Promise((resolveClose) => socket.addEventListener('close', resolveClose, { once: true }))
    await new Promise((resolveHello, reject) => {
      const timer = setTimeout(() => reject(new Error('Held socket hello timeout')), 5000)
      socket.addEventListener('message', (event) => {
        const message = JSON.parse(event.data)
        messages.push(message)
        if (message.t === 'hello') { clearTimeout(timer); resolveHello() }
      })
      socket.send(JSON.stringify({ t: 'auth', token: ticket.payload.token }))
    })
    return { socket, messages, closed }
  }
  await testInbox({ api, ids, heldSocket })
  async function mustClose(held) {
    let timer
    try {
      const event = await Promise.race([held.closed, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Revoked socket stayed open')), 5000) })])
      assert.equal(event.code, 4403)
    } finally { clearTimeout(timer) }
  }
  const ticket = await api('alpha', '/api/auth/ws-token', {
    method: 'POST',
    body: {},
  })
  assert.equal((await socketAuth('alpha', ticket.payload.token)).t, 'hello')
  const cross = await api('alpha', '/api/auth/ws-token', {
    method: 'POST',
    body: {},
  })
  assert.notEqual((await socketAuth('beta', cross.payload.token)).t, 'hello')
  const revoked = await api('alpha', '/api/auth/ws-token', {
    actor: 'alpha-member',
    method: 'POST',
    body: {},
  })
  const heldMember = await heldSocket(`/ws/channel/${general.id}`, 'alpha-member')
  await api('alpha', '/api/auth/logout', {
    actor: 'alpha-member',
    method: 'POST',
    body: {},
  })
  assert.notEqual((await socketAuth('alpha', revoked.payload.token)).t, 'hello')
  heldMember.socket.send(JSON.stringify({ t: 'message.create', content: 'Revoked socket must not write', clientId: crypto.randomUUID() }))
  await mustClose(heldMember)
  assert.equal(heldMember.messages.some((m) => m.t === 'message'), false)

  const verifier = 'a'.repeat(64)
  const challenge = Buffer.from(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)),
  ).toString('base64url')
  const authorize = await runtimes.alpha.dispatchFetch(
    origins.alpha +
      '/api/auth/connection/authorize?' +
      new URLSearchParams({
        redirect_uri: origins.alpha + '/connections',
        state: 's'.repeat(64),
        code_challenge: challenge,
      }),
    {
      redirect: 'manual',
      headers: {
        Host: new URL(origins.alpha).host,
        Cookie: cookies['alpha-owner'],
      },
    },
  )
  assert.equal(authorize.status, 302)
  const code = new URLSearchParams(
    new URL(authorize.headers.get('location')).hash.slice(1),
  ).get('llll_connection')
  const exchange = await api('alpha', '/api/auth/connection/exchange', {
    actor: 'embedded',
    method: 'POST',
    body: {
      code,
      code_verifier: verifier,
      redirect_uri: origins.alpha + '/connections',
    },
  })
  await api('alpha', '/api/me', { actor: 'embedded' })
  const signed = exchange.response.headers.get('set-auth-token')
  assert.ok(signed, 'Cookie-blocked clients need a signed local session token')
  await api('alpha', '/api/me', {
    actor: 'anonymous',
    headers: { Authorization: `Bearer ${signed}` },
  })
  await api('beta', '/api/me', {
    actor: 'anonymous',
    expected: 401,
    headers: { Authorization: `Bearer ${signed}` },
  })
  await api('alpha', '/api/auth/connection/exchange', {
    actor: 'anonymous',
    method: 'POST',
    expected: 401,
    body: {
      code,
      code_verifier: verifier,
      redirect_uri: origins.alpha + '/connections',
    },
  })
  await api('alpha', '/api/auth/login', {
    actor: 'alpha-member',
    method: 'POST',
    body: { email: 'member@example.com', password },
  })
  await api('alpha', `/api/servers/${ids.alpha}/members/${memberId}`, {
    method: 'DELETE',
  })
  await api('alpha', '/api/files/' + attachment.id, {
    actor: 'alpha-member',
    expected: 403,
  })
  await api('alpha', `/api/channels/${general.id}/messages`, {
    actor: 'alpha-member',
    expected: 403,
  })
  const recovery = await api('alpha', '/api/auth/recovery-key', {
    method: 'POST',
    body: {},
  })
  const old = await api('alpha', '/api/auth/ws-token', {
    method: 'POST',
    body: {},
  })
  const heldOwnerChannel = await heldSocket(`/ws/channel/${general.id}`)
  const heldOwnerServer = await heldSocket(`/ws/server/${ids.alpha}`)
  const newPassword = 'RecoveredOwnerPassword123!'
  await api('alpha', '/api/auth/recover', {
    actor: 'anonymous',
    method: 'POST',
    body: {
      email: 'owner@example.com',
      code: recovery.payload.code,
      password: newPassword,
    },
  })
  await api('alpha', '/api/me', { expected: 401 })
  assert.notEqual((await socketAuth('alpha', old.payload.token)).t, 'hello')
  await api('alpha', '/api/auth/recover', {
    actor: 'anonymous',
    method: 'POST',
    expected: 401,
    body: {
      email: 'owner@example.com',
      code: recovery.payload.code,
      password: newPassword,
    },
  })
  await api('alpha', '/api/auth/login', {
    method: 'POST',
    body: { email: 'owner@example.com', password: newPassword },
  })
  heldOwnerServer.socket.send(JSON.stringify({ t: 'activity', visible: true }))
  await api('alpha', `/api/channels/${general.id}/messages`, { method: 'POST', body: { content: 'Recovery session fanout' } })
  await mustClose(heldOwnerChannel)
  await mustClose(heldOwnerServer)
  assert.equal(heldOwnerChannel.messages.some((m) => m.t === 'message'), false)
  await api('alpha', '/api/auth/login', { actor: 'another-owner', method: 'POST', body: { email: 'owner@example.com', password: newPassword } })
  const revokedTab = await heldSocket(`/ws/channel/${general.id}`)
  const retainedTab = await heldSocket(`/ws/channel/${general.id}`, 'another-owner')
  const retainedMessage = new Promise((resolveMessage, reject) => {
    const timer = setTimeout(() => reject(new Error('Valid session did not receive fanout')), 5000)
    retainedTab.socket.addEventListener('message', (event) => {
      if (JSON.parse(event.data).t === 'message') { clearTimeout(timer); resolveMessage() }
    })
  })
  await api('alpha', '/api/auth/logout', { method: 'POST', body: {} })
  await api('alpha', `/api/channels/${general.id}/messages`, { actor: 'another-owner', method: 'POST', body: { content: 'Other owner session remains authorized' } })
  await mustClose(revokedTab)
  await retainedMessage
  assert.equal(retainedTab.messages.some((m) => m.t === 'message'), true)
  assert.equal(revokedTab.messages.some((m) => m.t === 'message'), false)
  retainedTab.socket.close()
  await api('alpha', '/api/auth/login', { method: 'POST', body: { email: 'owner@example.com', password: newPassword } })
  const a = await runtimes.alpha.getR2Bucket('FILES'),
    b = await runtimes.beta.getR2Bucket('FILES')
  await a.put('same-key', 'alpha')
  await b.put('same-key', 'beta')
  assert.equal(await (await a.get('same-key')).text(), 'alpha')
  assert.equal(await (await b.get('same-key')).text(), 'beta')
  const backup = await api(
    'alpha',
    `/api/servers/${ids.alpha}/backup-to-bucket`,
    { method: 'POST', body: {} },
  )
  assert.ok(backup.payload.sizeBytes > 0)
  assert.ok(backup.payload.key.includes(ids.alpha))
  const bucket = await runtimes.alpha.getR2Bucket('BACKUPS')
  // Update controls grant no membership, never reveal the backup capability,
  // and permit a single backup only for the job that owns this exact request.
  const hookId = '11111111-1111-4111-8111-111111111111'
  await api('alpha', `/api/servers/${ids.alpha}/updates/progress`, { actor: 'anonymous', expected: 401 })
  for (const [path, method, body] of [['progress', 'GET', undefined], ['request', 'POST', { requestId: hookId, release: 'v0.3.0' }], ['resume', 'POST', { requestId: hookId }]]) {
    await api('alpha', `/api/servers/${ids.alpha}/updates/${path}`, { actor: 'alpha-member', method, body, expected: 403 })
  }
  await api('alpha', `/api/servers/${ids.beta}/updates/request`, { method: 'POST', body: { requestId: hookId, release: 'v0.3.0' }, expected: 404 })
  // Exercise the actual workerd fetch implementation through the launch URL only:
  // the Server never starts an upload itself.
  const ownerRequest = { requestId: '55555555-5555-4555-8555-555555555555', release: 'v0.3.0' }
  const queued = (await api('alpha', `/api/servers/${ids.alpha}/updates/request`, { method: 'POST', body: ownerRequest })).payload
  assert.equal(queued.job.stage, 'queued'); assert.equal(queued.job.error, null)
  assert.ok(queued.launchUrl.startsWith('https://llll.gg/create?'))
  assert.equal(queued.launchUrl.includes(hookId), false)
  const requestAgain = (await api('alpha', `/api/servers/${ids.alpha}/updates/request`, { method: 'POST', body: ownerRequest })).payload
  assert.equal(requestAgain.job.id, ownerRequest.requestId); assert.equal(requestAgain.launchUrl, queued.launchUrl)
  await api('alpha', `/api/servers/${ids.alpha}/updates/resume`, { method: 'POST', body: { requestId: ownerRequest.requestId, cancel: true } })
  const controlDb = await runtimes.alpha.getD1Database('DB')
  const readControl = async () => JSON.parse((await controlDb.prepare('SELECT payload FROM server_update_control WHERE id=1').first()).payload)
  const saveControl = async value => controlDb.prepare('UPDATE server_update_control SET payload=?,revision=revision+1 WHERE id=1').bind(JSON.stringify(value)).run()
  const updateRecord = await readControl()
  assert.equal(updateRecord.hook, null)
  const progress = (await api('alpha', `/api/servers/${ids.alpha}/updates/progress`)).payload
  assert.equal(progress.configured, true); assert.equal(JSON.stringify(progress).includes('ciphertext'), false)
  const requestId = '22222222-2222-4222-8222-222222222222', buildId = '33333333-3333-4333-8333-333333333333'
  updateRecord.backupToken = 'a'.repeat(64); updateRecord.backupBusy = false
  updateRecord.job = { id: requestId, serverId: ids.alpha, requestedBy: 'owner', sourceVersion: '0.2.0-alpha.8', targetVersion: '0.3.0', stage: 'backing_up', buildId, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), backup: null, error: null }
  await saveControl(updateRecord)
  const capability = { actor: 'anonymous', method: 'POST', body: { requestId, buildId }, headers: { Authorization: `Bearer ${updateRecord.backupToken}` } }
  await api('alpha', `/api/servers/${ids.alpha}/updates/backup`, { ...capability, headers: { Authorization: `Bearer ${'b'.repeat(64)}` }, expected: 403 })
  await api('alpha', `/api/servers/${ids.alpha}/updates/backup`, { ...capability, body: { requestId, buildId: hookId }, expected: 403 })
  const updateBackup = (await api('alpha', `/api/servers/${ids.alpha}/updates/backup`, capability)).payload.backup
  assert.equal(updateBackup.verified, false); assert.ok(updateBackup.sizeBytes > 0)
  assert.equal(updateBackup.bucket, 'alpha-backups'); assert.match(updateBackup.sha256, /^[a-f0-9]{64}$/)
  await api('alpha', `/api/servers/${ids.alpha}/updates/backup`, { ...capability, expected: 409 })
  const ownedProgress = (await api('alpha', `/api/servers/${ids.alpha}/updates/progress`)).payload
  assert.equal(JSON.stringify(ownedProgress).includes(updateRecord.backupToken), false)
  assert.equal(ownedProgress.job.backup.key, updateBackup.key)
  updateRecord.job.stage = 'queued'; updateRecord.backupBusy = false
  await saveControl(updateRecord)
  await api('alpha', `/api/servers/${ids.alpha}/updates/resume`, { method: 'POST', body: { requestId, cancel: true } })
  assert.equal((await readControl()).backupToken, null)
  const object = await bucket.get(backup.payload.key)
  await mkdir(resolve(root, '.deployment/integration'), { recursive: true })
  const archive = resolve(root, '.deployment/integration/alpha.tar')
  await writeFile(archive, new Uint8Array(await object.arrayBuffer()), {
    mode: 0o600,
  })
  const entries = execFileSync('tar', ['-tf', archive], { encoding: 'utf8' })
    .trim()
    .split('\n')
  const restored = new DatabaseSync(':memory:')
  restored.exec('PRAGMA foreign_keys=ON; BEGIN;')
  restored.exec(
    entries
      .filter((n) =>
        /^database\/[0-9]{6}-(?:schema|indexes|[0-9]{6})\.sql$/.test(n),
      )
      .sort()
      .map((n) =>
        execFileSync('tar', ['-xOf', archive, n], { encoding: 'utf8' }),
      )
      .join('\n'),
  )
  restored.exec('COMMIT;')
  assert.equal(restored.prepare('SELECT id FROM server').get().id, ids.alpha)
  assert.equal(
    restored.prepare('SELECT id FROM server_identity').get().id,
    ids.alpha,
  )
  assert.deepEqual(restored.prepare('PRAGMA foreign_key_check').all(), [])
  assert.equal(restored.prepare('SELECT credential_json FROM mcp_outbound_connections WHERE id=?').get(outboundMcp.connectionId).credential_json, outboundMcp.credentialJson)
  assert.ok(restored.prepare('SELECT s.untrusted_at FROM agent_sessions s JOIN agent_runs r ON r.session_id=s.id WHERE r.id=?').get(outboundMcp.runId).untrusted_at)
  assert.equal(restored.prepare('SELECT credential_json AS credential FROM git_connections WHERE id=?').get(gitFixture.connectionId).credential, gitFixture.credentialJson)
  assert.equal(restored.prepare('SELECT project_id AS projectId FROM tasks WHERE id=?').get(projectFixture.taskId).projectId, projectFixture.projectId)
  assert.equal(restored.prepare('SELECT count(*) AS n FROM project_repositories WHERE project_id=?').get(projectFixture.projectId).n, 2)
  assert.equal(restored.prepare('SELECT status FROM agent_run_publications WHERE id=?').get(publication.publicationId).status, 'completed')
  assert.ok(restored.prepare('SELECT count(*) AS n FROM agent_tool_decisions WHERE run_id=?').get(outboundMcp.runId).n > 0)
  restored.close()
  console.log(
    'PASS: independent UUIDs, owner/member/invite/message, session isolation, HTTP denial, WebSocket isolation/revocation, PKCE replay denial, separate files and UUID-preserving backup restore',
  )
  if (process.argv.includes('--serve')) {
    const reviewChannelId = crypto.randomUUID()
    const reviewMemberId = crypto.randomUUID()
    await recoveryDb.batch([
      recoveryDb.prepare("INSERT INTO users(id,kind,display_name,status,role_id,joined_at) SELECT ?,'human','Legacy participant','active',id,? FROM roles WHERE key='member'").bind(reviewMemberId, new Date().toISOString()),
      recoveryDb.prepare("INSERT INTO channels(id,name,type,visibility) VALUES(?,'review-private-creator','text','private')").bind(reviewChannelId),
      recoveryDb.prepare('INSERT INTO channel_members(channel_id,user_id,joined_at) VALUES(?,?,?)').bind(reviewChannelId, reviewMemberId, new Date().toISOString()),
    ])
    await writeFile(
      resolve(root, '.deployment/integration/fixture.json'),
      JSON.stringify({
        origins,
        ids,
        ownerEmail: 'owner@example.com',
        password: newPassword,
        betaPassword: password,
        memberId,
      }),
      { mode: 0o600 },
    )
    console.log(`Local Servers: ${origins.alpha}, ${origins.beta}`)
    await new Promise((resolve) => {
      process.once('SIGINT', resolve)
      process.once('SIGTERM', resolve)
    })
  }
  }
} finally {
  await Promise.all(Object.values(runtimes).map((m) => m.dispose()))
}
