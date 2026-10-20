// Real Docker/Compose installation and cold restore of the prebuilt Server.
// Run only on an ephemeral amd64 Linux CI runner, after self-host/smoke.sh.
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { buildVpsRelease } from './build-vps-release.mjs'
import { writeReleaseManifest } from './release-artifacts.mjs'

if (process.env.GITHUB_ACTIONS !== 'true' || process.platform !== 'linux' || process.arch !== 'x64' || process.getuid() !== 0) throw new Error('This fixture requires an ephemeral root amd64 GitHub Actions runner')
if (existsSync('/usr/local/bin/llll')) throw new Error('Do not replace an existing installer CLI')
const root = resolve(import.meta.dirname, '..'), fixture = mkdtempSync(join(tmpdir(), 'llll-vps-live-'))
const directory = join(fixture, 'release'), bin = join(fixture, 'bin'), target = join(fixture, 'instance'), restored = join(fixture, 'restored')
const version = JSON.parse(readFileSync(resolve(root, 'package.json'))).version
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
mkdirSync(bin); mkdirSync(directory)
const runtime = join(fixture, 'runtime.tar')
const origin = 'http://127.0.0.1:38090'
const env = { ...process.env, PATH: bin + ':' + process.env.PATH, LLLL_DIR: target, LLLL_BACKUP_DIR: join(fixture, 'backups'), LLLL_DOMAIN: '127.0.0.1', LLLL_ADMIN_EMAIL: 'owner@example.com', LLLL_CHANNEL: 'prerelease', LLLL_NO_TLS: 'true', LLLL_HTTP_PORT: '38090', LLLL_HTTPS_PORT: '38443', LLLL_SKIP_DOCKER_INSTALL: 'true' }
const docker = args => execFileSync('docker', ['--host', 'unix:///var/run/docker.sock', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
async function run(script, args = [], overrides = {}) {
  // Keep the event loop running during Server restarts so Undici observes closed
  // keepalive connections instead of reusing a stale socket after cold restore.
  return new Promise((resolve, reject) => {
    const child = spawn('bash', [script, ...args], { env: { ...env, ...overrides }, timeout: 900000, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.once('error', reject)
    child.once('close', (code, signal) => {
      if (code !== 0) reject(new Error(`Installer failed (${code ?? signal}):\n${stderr}\n${stdout.replace(/claim=[^\s]+/g, 'claim=REDACTED')}`))
      else resolve(stdout)
    })
  })
}
let cookie = '', socket
async function api(path, { method = 'GET', body } = {}) {
  const response = await fetch(origin + path, { method, headers: { Origin: origin, Cookie: cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
  for (const value of response.headers.getSetCookie()) if (value.includes('session_token=')) cookie = value.split(';')[0]
  assert.equal(response.status, 200, `${path}: ${await response.clone().text()}`)
  return response
}
function dotenv(path) { return Object.fromEntries(readFileSync(path, 'utf8').trim().split('\n').map(line => { const index = line.indexOf('='); return [line.slice(0, index), line.slice(index + 1).replace(/^'|'$/g, '')] })) }
function cleanup(path) {
  if (!existsSync(join(path, '.env'))) return
  const config = dotenv(join(path, '.env'))
  // Delete only this randomly generated fixture's project. Never shared backups.
  if (!/^llll-vps-[a-f0-9]{12}$/.test(config.LLLL_PROJECT)) throw new Error('Invalid fixture project')
  docker(['compose', '--project-name', config.LLLL_PROJECT, '--env-file', join(path, '.env'), '-f', join(path, 'llll-compose.yml'), '-f', join(path, 'compose.vps.yml'), 'down', '--volumes'])
}
try {
  docker(['tag', 'llll:local', `llll:${version}`])
  docker(['save', '-o', runtime, `llll:${version}`])
  execFileSync('gzip', ['-1', runtime])
  await buildVpsRelease({ root, directory, runtime: runtime + '.gz', version, commit })
  for (const file of ['llll.tgz', 'llll-deployment.json', 'llll-cloudflare-manifest.json', 'llll-docs.tgz', 'llll-worker.mjs', 'llll-assets.json', `llll-deployment-core-${version}.tgz`]) writeFileSync(join(directory, file), 'fixture')
  await writeReleaseManifest(directory, { version, commit, releasePr: 1 })
  const realCurl = execFileSync('which', ['curl'], { encoding: 'utf8' }).trim()
  writeFileSync(join(bin, 'curl'), `#!/usr/bin/env node
import { copyFileSync } from 'node:fs'; import { spawnSync } from 'node:child_process';
const args=process.argv.slice(2), url=args.find(a=>a.startsWith('https://github.com/inchidev/llll/releases/download/'));
if(url){copyFileSync(${JSON.stringify(directory)}+'/'+url.split('/').at(-1),args[args.indexOf('-o')+1]);}
else{const r=spawnSync(${JSON.stringify(realCurl)},args,{stdio:'inherit'});process.exit(r.status??1);}
`, { mode: 0o755 })
  const installer = join(directory, 'install.sh')
  await run(installer)
  const firstEnv = readFileSync(join(target, '.env'), 'utf8'), config = dotenv(join(target, '.env'))
  const discovery = await (await api('/.well-known/llll')).json()
  const password = randomBytes(24).toString('hex')
  await api('/api/setup/owner', { method: 'POST', body: { token: config.SETUP_TOKEN, name: 'VPS acceptance owner', password } })
  const server = await (await api('/api/server')).json()
  const channels = await (await api(`/api/servers/${server.server.id}/channels`)).json()
  const general = channels.channels.find(channel => channel.name === 'general')
  const ticket = await (await api('/api/auth/ws-token', { method: 'POST', body: {} })).json()
  socket = new WebSocket(origin.replace('http:', 'ws:') + `/ws/channel/${general.id}`)
  const events = []
  socket.addEventListener('message', event => events.push(JSON.parse(event.data)))
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) })
  socket.send(JSON.stringify({ t: 'auth', token: ticket.token }))
  async function until(check) { for (let attempt = 0; attempt < 100; attempt++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 100)) } throw new Error('WebSocket acceptance timed out') }
  await until(() => events.some(event => event.t === 'hello'))
  const message = await (await api(`/api/channels/${general.id}/messages`, { method: 'POST', body: { content: 'VPS cold restore acceptance' } })).json()
  await until(() => events.some(event => event.t === 'message'))
  socket.close(); socket = undefined
  const form = new FormData(); form.append('file', new File(['private VPS backup file'], 'backup.txt', { type: 'text/plain' }))
  const upload = await fetch(origin + `/api/channels/${general.id}/attachments`, { method: 'POST', headers: { Origin: origin, Cookie: cookie }, body: form })
  assert.equal(upload.status, 200, await upload.clone().text())
  const attachment = (await upload.json()).attachment
  assert.ok(!(await run(installer)).includes('claim='))
  assert.equal(readFileSync(join(target, '.env'), 'utf8'), firstEnv)
  await run(join(target, 'llll'), ['backup'])
  const backup = readdirSync(env.LLLL_BACKUP_DIR).find(name => name.endsWith('.tar.gz'))
  await run(join(target, 'llll'), ['uninstall', '--yes', '--purge', '--no-backup'])
  assert.ok(existsSync(join(env.LLLL_BACKUP_DIR, backup)))
  await run(join(target, 'llll'), ['restore', join(env.LLLL_BACKUP_DIR, backup)], { LLLL_DIR: restored })
  assert.equal((await (await api('/.well-known/llll')).json()).id, discovery.id)
  assert.ok((await (await api(`/api/channels/${general.id}/messages`)).json()).messages.some(item => item.id === message.message.id))
  assert.equal(await (await api('/api/files/' + attachment.id)).text(), 'private VPS backup file')
  assert.equal((await api('/api/me')).status, 200)
  console.log('PASS: real amd64 installer, Caddy/owner/message/private file/WebSocket, idempotent credentials, full-volume backup, purge preserves backup, cold restore preserves UUID/session/message/file')
} finally {
  socket?.close()
  cleanup(existsSync(join(restored, '.env')) ? restored : target)
  rmSync(fixture, { recursive: true, force: true })
  rmSync('/usr/local/bin/llll', { force: true })
}
