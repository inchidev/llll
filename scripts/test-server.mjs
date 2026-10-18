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
  WORKSPACE_DO: 'WorkspaceDurableObject',
  RATE_LIMIT_DO: 'RateLimitDurableObject',
  NOTIFICATION_DO: 'NotificationDurableObject',
  AGENT_DO: 'L4Agent',
  AGENT_THINK: 'L4Think',
}
const origins = {
  alpha: `http://localhost:${port}`,
  beta: `http://localhost:${port + 1}`,
}
const instances = {}
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
  const response = await instances[server].dispatchFetch(
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
    instances[name] = new Miniflare(
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
    const db = await instances[name].getD1Database('DB')
    for (const file of (await readdir(resolve(root, 'drizzle/migrations')))
      .filter((n) => n.endsWith('.sql'))
      .sort())
      await db.exec(
        sql(await readFile(resolve(root, 'drizzle/migrations', file), 'utf8')),
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
    assert.equal(discovery.payload.ready, false)
    await api(name, '/api/setup/owner', {
      method: 'POST',
      body: { token: setup, name: 'Owner', password },
    })
    assert.ok(
      cookies[name + '-owner'],
      'Owner setup must establish a local session',
    )
    const home = await api(name, '/api/workspaces')
    assert.equal(home.payload.workspaces[0].id, ids[name])
    assert.equal((await api(name, '/.well-known/llll')).payload.id, ids[name])
    assert.equal((await api(name, '/.well-known/llll')).payload.ready, true)
    await api(name, '/api/workspaces/main/members', { expected: 404 })
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
    headers: { 'x-llll-identity': 'forged-installation-identity' },
  })
  const channels = await api('alpha', `/api/workspaces/${ids.alpha}/channels`)
  const general = channels.payload.channels.find((c) => c.name === 'general')
  assert.ok(general)
  const invite = await api('alpha', `/api/workspaces/${ids.alpha}/invites`, {
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
  assert.equal(sent.payload.message.workspaceId, ids.alpha)
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
  const upload = await instances.alpha.dispatchFetch(multipart.url, {
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
    const response = await instances[server].dispatchFetch(
      origins[server] + `/ws/workspace/${ids[server]}`,
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
  await api('alpha', '/api/auth/logout', {
    actor: 'alpha-member',
    method: 'POST',
    body: {},
  })
  assert.notEqual((await socketAuth('alpha', revoked.payload.token)).t, 'hello')
  const verifier = 'a'.repeat(64)
  const challenge = Buffer.from(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)),
  ).toString('base64url')
  const authorize = await instances.alpha.dispatchFetch(
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
  await api('alpha', `/api/workspaces/${ids.alpha}/members/${memberId}`, {
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
  const a = await instances.alpha.getR2Bucket('FILES'),
    b = await instances.beta.getR2Bucket('FILES')
  await a.put('same-key', 'alpha')
  await b.put('same-key', 'beta')
  assert.equal(await (await a.get('same-key')).text(), 'alpha')
  assert.equal(await (await b.get('same-key')).text(), 'beta')
  const backup = await api(
    'alpha',
    `/api/workspaces/${ids.alpha}/backup-to-bucket`,
    { method: 'POST', body: {} },
  )
  assert.ok(backup.payload.sizeBytes > 0)
  assert.ok(backup.payload.key.includes(ids.alpha))
  const bucket = await instances.alpha.getR2Bucket('BACKUPS')
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
  assert.equal(restored.prepare('SELECT id FROM workspace').get().id, ids.alpha)
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
  await Promise.all(Object.values(instances).map((m) => m.dispose()))
}
