import { Miniflare, convertV4MiniflareOptions, Log, LogLevel } from 'miniflare'
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises'
import { resolve, extname } from 'node:path'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { execFileSync } from 'node:child_process'
const root = resolve(import.meta.dirname, '..')
const port = Number(process.env.LLLL_TEST_PORT || 18984)
const password = 'LocalServerIntegrationPassword123!'
const setup = 'local-owner-claim-'.repeat(4)
const classes = {
  CHANNEL_DO: 'ChannelDurableObject',
  SERVER_DO: 'ServerDurableObject',
  RATE_LIMIT_DO: 'RateLimitDurableObject',
  NOTIFICATION_DO: 'NotificationDurableObject',
  AGENT_DO: 'L4Agent',
  AGENT_THINK: 'L4Think',
}
const origins = {
  alpha: `http://localhost:${port}`,
  beta: `http://localhost:${port + 1}`,
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
  if (!path.startsWith(resolve(root, '.output/public') + '/'))
    path = resolve(root, '.output/public/index.html')
  let data
  let extension = extname(path)
  try {
    data = await readFile(path)
  } catch {
    data = await readFile(resolve(root, '.output/public/index.html'))
    extension = '.html'
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
    headers = {},
  } = {},
) {
  const response = await runtimes[server].dispatchFetch(
    origins[server] + path,
    {
      method,
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
            r2Buckets: { FILES: name + '-files', BACKUPS: name + '-backups' },
            kvNamespaces: { TICKETS: name + '-tickets' },
            durableObjects: Object.fromEntries(
              Object.entries(classes).map(([binding, className]) => [
                binding,
                { className, useSQLite: true },
              ]),
            ),
            serviceBindings: { ASSETS: assets },
            bindings: {
              PUBLIC_ORIGIN: origins[name],
              LLLL_ACCOUNT_ID: 'a'.repeat(32),
              LLLL_WORKER_NAME: 'server-' + name,
              BACKUP_BUCKET_NAME: name + '-backups',
              AUTH_SECRET: (name + '-server-secret-').repeat(4),
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
    await api(name, '/api/setup/owner', {
      method: 'POST',
      body: { token: setup, name: 'Owner', password },
    })
    assert.ok(
      cookies[name + '-owner'],
      'Owner setup must establish a local session',
    )
    const home = await api(name, '/api/server')
    assert.equal(home.payload.server.id, ids[name])
    assert.equal((await api(name, '/.well-known/llll')).payload.id, ids[name])
    assert.equal((await api(name, '/.well-known/llll')).payload.ready, true)
    await api(name, `/api/servers/${ids[name]}`, { method: 'PATCH', body: { name: 'Renamed ' + name } })
    assert.equal((await api(name, '/.well-known/llll', { actor: 'anonymous' })).payload.name, 'Renamed ' + name)
    assert.equal((await api(name, '/api/setup/health', { actor: 'anonymous' })).payload.appName, 'Renamed ' + name)
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
      assert.deepEqual(Buffer.from(await publicIcon.response.arrayBuffer()), bytes)
      assert.equal(publicIcon.response.headers.get('content-type'), 'image/png')
    }
    await api(name, `/api/servers/${ids[name]}/icon`, { method: 'DELETE' })
    assert.equal((await api(name, '/.well-known/llll', { actor: 'anonymous' })).payload.iconUrl, null)
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
  // Update controls grant no membership, never reveal the Build hook/capability,
  // and permit a single backup only for the Build that owns this exact job.
  const hookId = '11111111-1111-4111-8111-111111111111'
  await api('alpha', `/api/servers/${ids.alpha}/updates/progress`, { actor: 'anonymous', expected: 401 })
  for (const [path, method, body] of [['progress', 'GET', undefined], ['config', 'PATCH', { hook: hookId }], ['request', 'POST', { requestId: hookId, release: 'v0.3.0' }], ['resume', 'POST', { requestId: hookId }]]) {
    await api('alpha', `/api/servers/${ids.alpha}/updates/${path}`, { actor: 'alpha-member', method, body, expected: 403 })
  }
  await api('alpha', `/api/servers/${ids.beta}/updates/config`, { method: 'PATCH', body: { hook: hookId }, expected: 404 })
  await api('alpha', `/api/servers/${ids.alpha}/updates/config`, { method: 'PATCH', body: { hook: 'https://evil.example/hook' }, expected: 400 })
  await api('alpha', `/api/servers/${ids.alpha}/updates/config`, { method: 'PATCH', body: { hook: hookId } })
  const stateKey = `control/server-updates/${ids.alpha}/state.json`
  const updateRecord = JSON.parse(await (await bucket.get(stateKey)).text())
  assert.ok(updateRecord.hook.ciphertext); assert.equal(JSON.stringify(updateRecord).includes(hookId), false)
  const progress = (await api('alpha', `/api/servers/${ids.alpha}/updates/progress`)).payload
  assert.equal(progress.configured, true); assert.equal(JSON.stringify(progress).includes('ciphertext'), false)
  const requestId = '22222222-2222-4222-8222-222222222222', buildId = '33333333-3333-4333-8333-333333333333'
  updateRecord.backupToken = 'a'.repeat(64); updateRecord.backupBusy = false
  updateRecord.job = { id: requestId, serverId: ids.alpha, requestedBy: 'owner', sourceVersion: '0.2.1', targetVersion: '0.2.2', stage: 'backing_up', buildId, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), backup: null, error: null }
  await bucket.put(stateKey, JSON.stringify(updateRecord))
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
  await bucket.put(stateKey, JSON.stringify(updateRecord))
  await api('alpha', `/api/servers/${ids.alpha}/updates/resume`, { method: 'POST', body: { requestId, cancel: true } })
  assert.equal(JSON.parse(await (await bucket.get(stateKey)).text()).backupToken, null)
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
  restored.close()
  console.log(
    'PASS: independent UUIDs, owner/member/invite/message, session isolation, HTTP denial, WebSocket isolation/revocation, PKCE replay denial, separate files and UUID-preserving backup restore',
  )
  if (process.argv.includes('--serve')) {
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
} finally {
  await Promise.all(Object.values(runtimes).map((m) => m.dispose()))
}
