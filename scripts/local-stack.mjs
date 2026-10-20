import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:net'
import { existsSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseArgs, parseEnv } from 'node:util'

const root = realpathSync(resolve(import.meta.dirname, '..'))
const directory = resolve(root, '.deployment/dev-stack')
const envFile = resolve(directory, '.env')
const args = process.argv.slice(2).filter(arg => arg !== '--')
const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
  'docker-context': { type: 'string' }, port: { type: 'string' },
  'frontend-port': { type: 'string' }, 'shell-port': { type: 'string' },
  'no-shell': { type: 'boolean' }, build: { type: 'boolean' },
  image: { type: 'string' }, help: { type: 'boolean', short: 'h' },
} })
const command = positionals[0] || 'dev'
if (values.help) {
  console.log(`Usage: pnpm stack -- <dev|up|status|logs|stop|down> [options]
  dev                     Watch backend, Client and Shell source
  up --build              Run a local production build through Caddy
  up --image llll:VERSION  Run an already loaded release image
  stop / down             Stop this stack; retain all volumes
  --docker-context NAME   Select a local Unix-socket Docker context
  --port / --shell-port / --frontend-port NUMBER
  --no-shell              Start only the standalone Server and its Client
Configuration and private setup link: .deployment/dev-stack/`)
  process.exit(0)
}
if (positionals.length > 1 || !['dev', 'up', 'status', 'logs', 'stop', 'down'].includes(command)) throw new Error('Unknown stack command; use --help.')
if ((values.build || values.image) && command !== 'up') throw new Error('--build and --image belong to up.')
if (values.build && values.image) throw new Error('Choose --build or --image.')

function dockerOutput(args, context) {
  const result = spawnSync('docker', [...(context ? ['--context', context] : []), ...args], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr.trim() || 'Docker is unavailable. Start Docker Desktop, OrbStack or Colima first.')
  return result.stdout.trim()
}
let config = existsSync(envFile) ? parseEnv(readFileSync(envFile, 'utf8')) : null
let context = values['docker-context'] || config?.LLLL_DOCKER_CONTEXT || process.env.DOCKER_CONTEXT
if (!context) {
  context = dockerOutput(['context', 'show'])
  if (context === 'default' && !existsSync('/var/run/docker.sock') && existsSync(`${process.env.HOME}/.colima/default/docker.sock`)) context = 'colima'
}
const endpoint = JSON.parse(dockerOutput(['context', 'inspect', context]))[0].Endpoints.docker.Host
if (!endpoint.startsWith('unix://') || (process.env.DOCKER_HOST && !process.env.DOCKER_HOST.startsWith('unix://'))) throw new Error('Local development requires a local Unix-socket Docker context; remote Docker hosts are refused.')
dockerOutput(['info', '--format', '{{.ServerVersion}}'], context)

async function freePort(preferred) {
  if (!Number.isInteger(preferred) || preferred < 1024 || preferred > 65535) throw new Error('Ports must be integers from 1024 to 65535.')
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(preferred, '127.0.0.1', () => server.close(() => resolve(preferred)))
  })
}
async function selectPort(explicit, preferred) {
  if (explicit) return freePort(Number(explicit))
  for (let port = preferred; port < preferred + 100; port++) {
    try { return await freePort(port) } catch (error) { if (error.code !== 'EADDRINUSE') throw error }
  }
  throw new Error('No available local ports. Select a port explicitly.')
}
if (!config) {
  if (!['dev', 'up'].includes(command)) throw new Error('No local stack configuration. Start with pnpm dev:stack.')
  const port = await selectPort(values.port, 3000)
  const frontendPort = await selectPort(values['frontend-port'], port + 1)
  const shellPort = await selectPort(values['shell-port'], frontendPort + 1)
  if (new Set([port, frontendPort, shellPort]).size !== 3) throw new Error('Client, frontend and Shell ports must differ.')
  const project = 'llll-' + createHash('sha256').update(root).digest('hex').slice(0, 10)
  config = {
    LLLL_PROJECT: project, LLLL_DOCKER_CONTEXT: context,
    LLLL_HTTP_PORT: String(port), LLLL_FRONTEND_PORT: String(frontendPort),
    LLLL_SHELL_ORIGIN: `http://localhost:${shellPort}`,
    LLLL_SITE_ADDRESS: 'http://:80', PUBLIC_ORIGIN: `http://localhost:${port}`,
    AUTH_SECRET: randomBytes(32).toString('hex'), SETUP_TOKEN: randomBytes(32).toString('hex'),
    ADMIN_EMAIL: 'owner@example.com', APP_NAME: 'L4 Local',
    RUSTFS_ACCESS_KEY: randomBytes(16).toString('hex'), RUSTFS_SECRET_KEY: randomBytes(32).toString('hex'),
    RUSTFS_BUCKET: 'cells', AWS_REGION: 'us-east-1', EMBED_ORIGINS: `http://localhost:${shellPort}`,
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  writeFileSync(envFile, Object.entries(config).map(([key, value]) => `${key}=${value}`).join('\n') + '\n', { mode: 0o600, flag: 'wx' })
} else {
  for (const [flag, key] of [['port', 'LLLL_HTTP_PORT'], ['frontend-port', 'LLLL_FRONTEND_PORT']]) {
    if (values[flag] && values[flag] !== config[key]) throw new Error(`Edit ${envFile} to change persisted ports; secrets and identity are retained.`)
  }
  if (values['shell-port'] && Number(values['shell-port']) !== Number(new URL(config.LLLL_SHELL_ORIGIN).port)) throw new Error('The Shell port is persisted in the local env file.')
}
const modeFile = resolve(directory, 'mode')
const lockFile = resolve(directory, 'dev.pid')
function developmentRunning() {
  if (!existsSync(lockFile)) return false
  const pid = Number(readFileSync(lockFile, 'utf8'))
  if (!Number.isInteger(pid) || pid < 1) throw new Error('Invalid local dev.pid; inspect the local stack before removing it.')
  try { process.kill(pid, 0); return true }
  catch (error) { if (error.code === 'ESRCH') return false; throw error }
}
if (command === 'up' && developmentRunning()) throw new Error('Stop the foreground dev:stack command before changing modes.')
const mode = command === 'dev' ? 'dev' : command === 'up' ? 'build' : existsSync(modeFile) ? readFileSync(modeFile, 'utf8').trim() : 'build'
const composeArgs = ['--context', context, 'compose', '--project-name', config.LLLL_PROJECT, '--env-file', envFile,
  '-f', resolve(root, 'self-host/docker-compose.yml'),
  ...(mode === 'dev' ? ['-f', resolve(root, 'self-host/compose.dev.yml')] : []),
  ...(command === 'up' && values.build ? ['-f', resolve(root, 'self-host/compose.build.yml')] : []),
]
const env = { ...process.env, ...config, LLLL_ENV_FILE: envFile, LLLL_IMAGE: values.image || config.LLLL_IMAGE || 'llll:local' }
const children = new Set()
let closing = false
let managesContainers = false
let ownsLock = false
function run(executable, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: root, env, stdio: 'inherit', detached: true, ...options })
    children.add(child)
    child.once('error', reject)
    child.once('exit', code => { children.delete(child); code === 0 ? resolve() : reject(new Error(`${executable} exited (${code})`)) })
  })
}
async function waitFor(check, description, timeout = 180000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (closing) throw new Error('Startup stopped')
    try { if (await check()) return } catch { /* Retry until the service is ready. */ }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error(`Timed out waiting for ${description}`)
}
async function shutdown() {
  if (closing) return
  closing = true
  const groups = [...children].map(child => child.pid).filter(Boolean)
  for (const pid of groups) {
    try { process.kill(-pid, 'SIGTERM') } catch { /* Already exited. */ }
  }
  await Promise.all(groups.map(async (pid) => {
    const deadline = Date.now() + 3000
    while (Date.now() < deadline) {
      try { process.kill(-pid, 0) } catch { return }
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    // A Rollup watcher can be busy finishing a failed build when closed. Do
    // not leave an orphan compiler writing into the next session's output.
    try { process.kill(-pid, 'SIGKILL') } catch { /* Already exited. */ }
  }))
  const unlock = () => { if (ownsLock) { unlinkSync(lockFile); ownsLock = false } }
  if (!managesContainers) { unlock(); return }
  // Stop only services started by this invocation. A second dev command that
  // fails its port preflight must not stop the already running Server.
  const stopped = await new Promise(resolve => {
    const child = spawn('docker', [...composeArgs, 'stop'], { cwd: root, env, stdio: 'inherit', timeout: 55000 })
    child.once('error', () => resolve(false))
    child.once('exit', code => resolve(code === 0))
  })
  if (!stopped) console.error('Could not stop the local stack; run pnpm stack -- stop.')
  unlock()
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  if (command === 'dev') { void shutdown().then(() => process.exit(0)); return }
  for (const child of children) {
    try { process.kill(-child.pid, 'SIGTERM') } catch { /* Already exited. */ }
  }
  process.exit(0)
})
try {
  if (!['dev', 'up'].includes(command)) {
    await run('docker', [...composeArgs, command === 'status' ? 'ps' : command === 'logs' ? 'logs' : command, ...(command === 'logs' ? ['--follow', '--tail', '100'] : [])])
  } else {
    writeFileSync(modeFile, mode, { mode: 0o600 })
    if (command === 'dev') {
      if (developmentRunning()) throw new Error('This worktree already has a running dev:stack command.')
      if (existsSync(lockFile)) unlinkSync(lockFile)
      writeFileSync(lockFile, String(process.pid), { mode: 0o600, flag: 'wx' })
      ownsLock = true
      await freePort(Number(config.LLLL_FRONTEND_PORT))
      if (!values['no-shell']) await freePort(Number(new URL(config.LLLL_SHELL_ORIGIN).port))
      // An empty dotenv file prevents a checkout's personal .env being loaded
      // into Nuxt. Backend credentials remain only in Compose's private env.
      writeFileSync(resolve(directory, 'frontend.env'), '', { mode: 0o600 })
      const marker = resolve(directory, 'backend/.build.json')
      if (existsSync(marker)) unlinkSync(marker)
      const frontendEnv = { ...process.env, NODE_ENV: 'development', LLLL_CLIENT_MODE: 'web', LLLL_STATIC_CLIENT: 'false', LLLL_DEV_STACK: 'true', LLLL_DEV_PROXY_ORIGIN: config.PUBLIC_ORIGIN }
      const frontend = run('pnpm', ['exec', 'nuxt', 'dev', '--host', '0.0.0.0', '--port', config.LLLL_FRONTEND_PORT, '--dotenv', resolve(directory, 'frontend.env')], { env: frontendEnv })
      const backend = run('node', ['scripts/dev-backend.mjs'], { env: { ...process.env, NODE_ENV: 'production', LLLL_CLIENT_MODE: 'web', LLLL_STATIC_CLIENT: 'false', LLLL_DEV_PROXY_ORIGIN: '' } })
      const jobs = [frontend, backend]
      if (!values['no-shell']) jobs.push(run('node', ['scripts/dev-shell.mjs']))
      // Observe failures immediately, including those during the initial build.
      for (const job of jobs) job.catch(error => { if (!closing) { console.error(error.message); void shutdown().then(() => process.exit(1)) } })
      await waitFor(() => existsSync(resolve(directory, 'backend/.build.json')), 'the backend compiler')
      managesContainers = true
      await run('docker', [...composeArgs, 'up', '-d', '--build', '--wait', '--wait-timeout', '240'])
    } else {
      if (!values.build && !values.image && !config.LLLL_IMAGE) throw new Error('Select a verified loaded image with --image llll:VERSION, or use --build for a local source build.')
      await run('docker', [...composeArgs, 'up', '-d', ...(values.build ? ['--build'] : []), '--wait', '--wait-timeout', '240'])
    }
    await waitFor(async () => (await fetch(`${config.PUBLIC_ORIGIN}/.well-known/llll`, { signal: AbortSignal.timeout(5000) })).ok, 'Server discovery')
    await waitFor(async () => (await fetch(config.PUBLIC_ORIGIN, { signal: AbortSignal.timeout(5000) })).ok, 'the Client')
    if (command === 'dev' && !values['no-shell']) await waitFor(async () => (await fetch(config.LLLL_SHELL_ORIGIN + '/create', { signal: AbortSignal.timeout(5000) })).ok, 'the Shell')
    const discovery = await (await fetch(`${config.PUBLIC_ORIGIN}/.well-known/llll`)).json()
    const setupFile = resolve(directory, 'setup.url')
    writeFileSync(setupFile, discovery.ready ? config.PUBLIC_ORIGIN + '\n' : `${config.PUBLIC_ORIGIN}/setup#claim=${config.SETUP_TOKEN}\n`, { mode: 0o600 })
    console.log(`\nStandalone Server: ${config.PUBLIC_ORIGIN}\nServer UUID: ${discovery.id}\nPrivate setup link: ${setupFile}\nConfiguration: ${envFile}`)
    if (command === 'dev' && !values['no-shell']) console.log(`Shell: ${config.LLLL_SHELL_ORIGIN}/create?server=${encodeURIComponent(config.PUBLIC_ORIGIN)}`)
    if (command === 'dev') {
      console.log('Client HMR and backend reload are active. Ctrl+C stops this stack and keeps its data.')
      await new Promise(() => {})
    }
  }
} catch (error) {
  console.error(error.message)
  if (command === 'dev') await shutdown()
  process.exitCode = 1
}
