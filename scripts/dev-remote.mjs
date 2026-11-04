import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseArgs, parseEnv } from 'node:util'

function options() {
  const args = process.argv.slice(2)
  while (args[0] === '--') args.shift()
  const { values, positionals } = parseArgs({
    args,
    options: { 'env-file': { type: 'string' }, help: { type: 'boolean', short: 'h' } },
    allowPositionals: true,
  })
  if (values.help) return null
  if (positionals.length > 1) throw new Error('Pass one remote URL, optionally with --env-file <path>.')

  const envFile = resolve(values['env-file'] ?? '.env')
  if (values['env-file'] && !existsSync(envFile)) throw new Error('The selected env file does not exist.')
  const fileEnv = existsSync(envFile) ? parseEnv(readFileSync(envFile, 'utf8')) : {}
  const env = { ...fileEnv, ...process.env }
  const target = positionals[0] ?? env.LLLL_DEV_PROXY_ORIGIN
  if (!target) throw new Error('Set LLLL_DEV_PROXY_ORIGIN in the environment or selected env file, or pass a remote URL.')

  let url
  try { url = new URL(target) }
  catch { throw new Error('The remote URL must be an HTTP or HTTPS origin.') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('The remote URL must be an HTTP or HTTPS origin without credentials, a path, query, or fragment.')
  }
  return { envFile, env: { ...env, LLLL_DEV_PROXY_ORIGIN: url.origin } }
}

let config
try { config = options() }
catch (error) {
  console.error(error.message)
  process.exit(1)
}

if (!config) {
  console.log('Usage: pnpm dev:remote -- [https://chat.example.com] [--env-file .env.personal]')
  process.exit(0)
}

const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
console.log(`Proxying local /api to ${config.env.LLLL_DEV_PROXY_ORIGIN}; WebSockets connect directly`)
const result = spawnSync(pnpm, ['exec', 'nuxt', 'dev', '--dotenv', config.envFile], {
  cwd: process.cwd(),
  env: config.env,
  stdio: 'inherit',
})

if (result.error) throw result.error
process.exit(result.status ?? 1)
