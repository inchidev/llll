import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { requireWorkersBuild } from './ci-only.mjs'

requireWorkersBuild()
const root = resolve(import.meta.dirname, '..')
const mode = process.argv[2]
const branch = process.env.WORKERS_CI_BRANCH
if (!['preview', 'production'].includes(mode) || (mode === 'production') !== (branch === 'main')) throw new Error('Production requires main; all other branches require an open PR and a Preview')
const account = process.env.CLOUDFLARE_ACCOUNT_ID
const token = process.env.CLOUDFLARE_API_TOKEN
if (!account || !token) throw new Error('Workers Builds credentials are missing')
async function api(path, body) {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}${path}`, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
  const data = await response.json()
  if (!response.ok || !data.success) throw new Error(`Cloudflare ${path}: ${data.errors?.map(error => error.message).join('; ') || response.status}`)
  return data
}
let pr
if (mode === 'preview') {
  const response = await fetch(`https://api.github.com/repos/inchidev/llll/pulls?state=open&head=${encodeURIComponent(`inchidev:${branch}`)}`, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'L4-Workers-Builds' } })
  if (!response.ok) throw new Error(`Cannot verify the PR: GitHub ${response.status}`)
  pr = (await response.json()).find(item => item.base.ref === 'main' && item.head.sha === process.env.WORKERS_CI_COMMIT_SHA)
  if (!pr) throw new Error('Only the current head of an open PR to main can create a Preview')
}
const databaseName = mode === 'production' ? 'llll-portal-production' : `llll-portal-pr-${pr.number}`
let database
for (let page = 1; ; page++) {
  const data = await api(`/d1/database?per_page=100&page=${page}`)
  database = data.result.find(item => item.name === databaseName)
  if (database || page >= (data.result_info?.total_pages || 1)) break
}
database ||= (await api('/d1/database', { name: databaseName })).result
const config = JSON.parse(await readFile(resolve(root, 'apps/site/wrangler.jsonc'), 'utf8'))
config.main = resolve(root, 'apps/site/.bundle/index.mjs')
config.assets.directory = resolve(root, 'apps/site/.output/public')
config.d1_databases = [{ binding: 'PORTAL_DB', database_name: databaseName, database_id: database.uuid || database.id, migrations_dir: resolve(root, 'apps/site/migrations') }]
config.vars.ENVIRONMENT = mode
config.vars.BUILD_COMMIT = process.env.WORKERS_CI_COMMIT_SHA
if (mode === 'preview') delete config.vars.CLOUDFLARE_OAUTH_CLIENT_ID
// Each Preview has its own D1. Do not inherit a shared base-config database.
config.previews = { vars: config.vars, d1_databases: config.d1_databases }
const work = resolve(root, '.deployment/builds')
await mkdir(work, { recursive: true })
const configFile = resolve(work, 'web.json')
await writeFile(configFile, JSON.stringify(config))
const secretFile = resolve(work, 'secrets.json')
const secret = mode === 'production' ? process.env.PORTAL_AUTH_SECRET : randomBytes(32).toString('hex')
if (!secret) throw new Error('Production PORTAL_AUTH_SECRET is required')
await writeFile(secretFile, JSON.stringify({ AUTH_SECRET: secret }), { mode: 0o600 })
function wrangler(args, capture = false) {
  const result = spawnSync('pnpm', ['exec', 'wrangler', ...args], { cwd: root, encoding: 'utf8', stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit' })
  if (result.status !== 0) { if (capture) process.stderr.write(result.stderr || result.stdout); throw new Error(`Remote Wrangler ${args[0]} failed`) }
  return result.stdout
}
wrangler(['d1', 'migrations', 'apply', 'PORTAL_DB', '--remote', '--config', configFile])
const output = wrangler(mode === 'preview'
  ? ['preview', '--config', configFile, '--name', `pr-${pr.number}`, '--ignore-base-config', '--secrets-file', secretFile, '--json']
  : ['deploy', '--config', configFile, '--secrets-file', secretFile], true)
process.stdout.write(output)
if (mode === 'preview') {
  const data = JSON.parse(output.slice(output.indexOf('{')))
  const url = data.preview?.urls?.[0]
  if (!url) throw new Error('Cloudflare did not return a Worker Preview URL')
  let verified = false
  for (let attempt = 0; attempt < 12; attempt++) {
    const response = await fetch(`${url}/api/health`).catch(() => null)
    if (response?.ok && (await response.json()).commit === process.env.WORKERS_CI_COMMIT_SHA) { verified = true; break }
    await new Promise(resolveWait => setTimeout(resolveWait, 2000))
  }
  if (!verified) throw new Error('Deployed Preview verification failed')
  console.log(`Verified PR ${pr.number} Preview: ${url}`)
}
