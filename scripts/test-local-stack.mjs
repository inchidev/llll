// Requires pnpm dev:stack. Verifies a disposable, independent Compose project;
// never claims or clears the developer's Server.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:net'
import { readFile, writeFile, unlink } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parseEnv } from 'node:util'
import WebSocket from 'ws'

const root = resolve(import.meta.dirname, '..')
const directory = resolve(root, '.deployment/dev-stack')
const config = parseEnv(await readFile(resolve(directory, '.env'), 'utf8'))
const inspected = spawnSync('docker', ['context', 'inspect', config.LLLL_DOCKER_CONTEXT], { encoding: 'utf8' })
assert.equal(inspected.status, 0, 'The saved local Docker context must exist')
assert.ok(JSON.parse(inspected.stdout)[0].Endpoints.docker.Host.startsWith('unix://'), 'Remote Docker contexts are refused')
const server = createServer()
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
await new Promise(resolve => server.close(resolve))
const origin = `http://localhost:${port}`
const runId = randomBytes(6).toString('hex')
const project = `${config.LLLL_PROJECT}-verify-${runId}`
const fixture = {
  ...config, LLLL_PROJECT: project, LLLL_HTTP_PORT: String(port), PUBLIC_ORIGIN: origin,
  AUTH_SECRET: randomBytes(32).toString('hex'), SETUP_TOKEN: randomBytes(32).toString('hex'),
  RUSTFS_ACCESS_KEY: randomBytes(16).toString('hex'), RUSTFS_SECRET_KEY: randomBytes(32).toString('hex'),
}
const envFile = resolve(directory, `${project}.env`)
await writeFile(envFile, Object.entries(fixture).map(([key, value]) => `${key}=${value}`).join('\n'), { mode: 0o600, flag: 'wx' })
const compose = ['--context', config.LLLL_DOCKER_CONTEXT, 'compose', '--project-name', project, '--env-file', envFile,
  '-f', resolve(root, 'self-host/docker-compose.yml'), '-f', resolve(root, 'self-host/compose.dev.yml')]
const env = { ...process.env, ...fixture, LLLL_ENV_FILE: envFile }
// Use the already built dev runtime image, without rebuilding another image.
const imageOverride = resolve(directory, `${project}.yml`)
await writeFile(imageOverride, `services:\n  llll:\n    image: ${config.LLLL_PROJECT}-dev:celld-0.6.3\n`, { mode: 0o600 })
compose.push('-f', imageOverride)
function docker(args, capture = false) {
  const result = spawnSync('docker', [...compose, ...args], { cwd: root, env, stdio: capture ? 'pipe' : 'inherit', encoding: 'utf8' })
  assert.equal(result.status, 0, capture ? result.stderr : `Compose ${args[0]} failed`)
  return result.stdout
}
const cookies = {}
async function api(path, { actor = 'owner', method = 'GET', body, expected = 200 } = {}) {
  const response = await fetch(origin + path, {
    method,
    signal: AbortSignal.timeout(15000),
    headers: { Origin: origin, Cookie: cookies[actor] || '', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  for (const cookie of response.headers.getSetCookie()) if (cookie.includes('session_token=')) cookies[actor] = cookie.split(';')[0]
  assert.equal(response.status, expected, `${method} ${path}: ${await response.clone().text()}`)
  return response
}
async function until(check, label, timeoutMs = 120000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    try { if (await check()) return Date.now() - started } catch { /* A deployment can be moving. */ }
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  throw new Error(`Timed out: ${label}`)
}
const routePath = `/api/__local_reload_${runId}`
const routeFile = resolve(root, `server/api/__local_reload_${runId}.get.ts`)
let socket
try {
  docker(['up', '-d', '--no-build', '--wait', '--wait-timeout', '240'])
  const discovery = await (await api('/.well-known/llll')).json()
  assert.equal(discovery.ready, false)
  const developer = await (await fetch(config.PUBLIC_ORIGIN + '/.well-known/llll')).json()
  assert.notEqual(discovery.id, developer.id, 'Separate volumes must produce independent Servers')
  const password = randomBytes(24).toString('hex')
  await api('/api/setup/owner', { method: 'POST', body: { token: fixture.SETUP_TOKEN, name: 'Acceptance owner', password } })
  const home = await (await api('/api/server')).json()
  const channels = await (await api(`/api/servers/${home.server.id}/channels`)).json()
  const general = channels.channels.find(channel => channel.name === 'general')
  assert.ok(general)
  const invite = await (await api(`/api/servers/${discovery.id}/invites`, { method: 'POST', body: { maxUses: 2 } })).json()
  await api('/api/auth/signup', { actor: 'member', method: 'POST', body: { name: 'Acceptance member', email: 'member@example.com', password, inviteCode: invite.invite.code, accepted: true } })
  await api(`/api/invites/${invite.invite.code}/accept`, { actor: 'member', method: 'POST', body: {} })
  const ticket = await (await api('/api/auth/ws-token', { actor: 'member', method: 'POST', body: {} })).json()
  socket = new WebSocket(origin.replace('http:', 'ws:') + `/ws/channel/${general.id}`)
  const events = []
  socket.on('message', data => events.push(JSON.parse(data.toString())))
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject) })
  socket.send(JSON.stringify({ t: 'auth', token: ticket.token }))
  await until(() => events.some(event => event.t === 'hello'), 'WebSocket authentication through Caddy')
  const sent = await (await api(`/api/channels/${general.id}/messages`, { actor: 'member', method: 'POST', body: { content: 'Persistent celld acceptance message' } })).json()
  await until(() => events.some(event => event.t === 'message'), 'realtime message fanout')
  const form = new FormData()
  form.append('file', new File(['persistent private file'], 'acceptance.txt', { type: 'text/plain' }))
  const uploaded = await fetch(origin + `/api/channels/${general.id}/attachments`, { method: 'POST', headers: { Origin: origin, Cookie: cookies.owner }, body: form })
  assert.equal(uploaded.status, 200, await uploaded.clone().text())
  const attachment = (await uploaded.json()).attachment
  await api('/api/files/' + attachment.id, { actor: 'anonymous', expected: 401 })
  assert.equal(await (await api('/api/files/' + attachment.id)).text(), 'persistent private file')
  console.log('PASS: separate UUID, owner claim, invite/member, message, file authorization and realtime through Caddy')

  await writeFile(routeFile, "export default defineEventHandler(() => ({ marker: 'first' }))\n", { flag: 'wx' })
  await until(async () => (await (await api(routePath)).json()).marker === 'first', 'new backend route', 300000)
  await writeFile(routeFile, 'export default defineEventHandler(() => { syntax error\n')
  await new Promise(resolve => setTimeout(resolve, 3000))
  assert.equal((await (await api(routePath)).json()).marker, 'first', 'A failed build must retain the running deployment')
  await writeFile(routeFile, "export default defineEventHandler(() => ({ marker: 'second' }))\n")
  // A failed transform can require rebuilding the entire Pi graph rather than a warm incremental edit.
  const repairedMs = await until(async () => (await (await api(routePath)).json()).marker === 'second', 'repaired backend build', 300000)
  console.log(`PASS: repaired backend build in ${Math.round(repairedMs / 1000)}s`)
  assert.equal((await (await api('/.well-known/llll')).json()).id, discovery.id)
  assert.equal(await (await api('/api/files/' + attachment.id)).text(), 'persistent private file')
  socket.close()
  socket = null
  docker(['restart', 'llll'])
  await until(async () => (await fetch(origin + '/api/setup/health')).ok, 'restart health')
  assert.equal((await (await api('/.well-known/llll')).json()).id, discovery.id)
  const messages = await (await api(`/api/channels/${general.id}/messages`)).json()
  assert.ok(messages.messages.some(message => message.id === sent.message.id))
  assert.equal(await (await api('/api/files/' + attachment.id)).text(), 'persistent private file')
  await until(async () => (await (await api('/.well-known/llll')).json()).ready === true, 'claimed state after restart')
  console.log('PASS: added/edited backend route, failed-build recovery, UUID/session/message/file persistence and container restart')
} finally {
  socket?.terminate()
  await unlink(routeFile).catch(() => {})
  // This random disposable project owns no backup destination. Never prune.
  docker(['down', '--volumes'])
  await unlink(envFile)
  await unlink(imageOverride)
}
