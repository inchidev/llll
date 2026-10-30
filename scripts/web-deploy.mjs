import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { requireWorkersBuild } from './ci-only.mjs'
import { pullRequestCandidate, verifyMergeParents } from './pull-request-ref.mjs'
import { compareVersions } from './release-policy.mjs'
import { findD1Database } from './cloudflare-d1.mjs'

requireWorkersBuild()
const root = resolve(import.meta.dirname, '..')
const mode = process.argv[2]
const branch = process.env.WORKERS_CI_BRANCH
// main: the standing Preview of everything merged into main, before any release.
if (!['preview', 'production', 'main'].includes(mode) || (mode !== 'preview') !== (branch === 'main')) throw new Error('Production and the main Preview require main; all other branches require an open PR and a Preview')
let production
if (mode === 'production') {
  production = JSON.parse(await readFile(resolve(root, '.deployment/released/plan.json'), 'utf8'))
  if (production.skip) { console.log(production.reason); process.exit(0) }
  if (!/^[a-f0-9]{40}$/.test(production.commit)) throw new Error('Verified release plan is missing')
  const response = await fetch('https://llll.gg/api/health', { signal: AbortSignal.timeout(15000) })
  if (!response.ok) throw new Error('Cannot verify production before deployment')
  const live = await response.json()
  if (live.commit === production.commit || (live.version && compareVersions(live.version, production.version) >= 0)) { console.log('Release already deployed or superseded: production unchanged'); process.exit(0) }
}
const account = process.env.CLOUDFLARE_ACCOUNT_ID
const token = process.env.CLOUDFLARE_API_TOKEN
if (!account || !token) throw new Error('Workers Builds credentials are missing')
async function api(path, body) {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}${path}`, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
  const data = await response.json()
  if (!response.ok || !data.success) throw new Error(`Cloudflare ${path}: ${data.errors?.map(error => error.message).join('; ') || response.status}`)
  return data
}
function git(args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  if (result.status !== 0) throw new Error('Cannot verify the PR Git refs')
  return result.stdout
}
// Manual Builds can omit the webhook SHA. Still require the checked-out Git
// commit to equal the current PR head and verify both merge parents below.
const sourceCommit = process.env.WORKERS_CI_COMMIT_SHA || git(['rev-parse', 'HEAD']).trim()
let pr
if (mode === 'main') {
  // An older main Build must not replace a newer one.
  const head = git(['ls-remote', 'https://github.com/inchidev/llll.git', 'refs/heads/main']).split(/\s/)[0]
  if (head !== sourceCommit) throw new Error('The main Preview deploys only the current head of main')
}
if (mode === 'preview') {
  // Git refs avoid the shared unauthenticated REST API quota in Builds.
  // A merge ref plus both parents proves this head is mergeable into current main.
  const repository = 'https://github.com/inchidev/llll.git'
  for (let attempt = 0; attempt < 6; attempt++) {
    const refs = git(['ls-remote', repository, 'refs/heads/main', `refs/heads/${branch}`, 'refs/pull/*'])
    const candidate = pullRequestCandidate(refs, branch, sourceCommit)
    if (candidate) {
      git(['fetch', '--no-tags', '--depth=1', repository, `refs/pull/${candidate.number}/merge`])
      if (verifyMergeParents(git(['cat-file', '-p', 'FETCH_HEAD']), candidate)) { pr = candidate; break }
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 2000))
  }
  if (!pr) throw new Error('Preview requires the current head of a mergeable PR to main. Open or update the PR and retry the Build.')
}
const databaseName = mode === 'production' ? 'llll' : mode === 'main' ? 'llll-main' : `llll-pr-${pr.number}`
let database = await findD1Database(api, databaseName)
if (!database && mode === 'production') throw new Error('Production D1 llll must already exist; provision or migrate it through the connected API before deploying')
database ||= (await api('/d1/database', { name: databaseName })).result
const site = production?.site || resolve(root, 'apps/site')
const config = JSON.parse(await readFile(resolve(site, 'wrangler.jsonc'), 'utf8'))
if (config.name !== 'llll') throw new Error('Release archive targets an unexpected Worker')
config.main = resolve(site, '.bundle/index.mjs')
config.assets.directory = resolve(site, '.output/public')
config.d1_databases = [{ binding: 'DB', database_name: databaseName, database_id: database.uuid || database.id, migrations_dir: resolve(site, 'migrations') }]
config.vars.ENVIRONMENT = mode === 'production' ? 'production' : 'preview'
config.vars.BUILD_COMMIT = production?.commit || sourceCommit
config.vars.BUILD_VERSION = production?.version || JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')).version
if (mode !== 'production') delete config.vars.CLOUDFLARE_OAUTH_CLIENT_ID
// Each Preview has its own D1. Do not inherit a shared base-config database.
config.previews = { vars: config.vars, d1_databases: config.d1_databases }
const work = resolve(root, '.deployment/builds')
await mkdir(work, { recursive: true })
const configFile = resolve(work, 'web.json')
await writeFile(configFile, JSON.stringify(config))
const secretFile = resolve(work, 'secrets.json')
const secret = mode === 'production' ? process.env.WEB_AUTH_SECRET : randomBytes(32).toString('hex')
if (!secret) throw new Error('Production WEB_AUTH_SECRET is required')
await writeFile(secretFile, JSON.stringify({ AUTH_SECRET: secret }), { mode: 0o600 })
function wrangler(args, capture = false) {
  const result = spawnSync('pnpm', ['exec', 'wrangler', ...args], { cwd: root, encoding: 'utf8', stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit' })
  if (result.status !== 0) { if (capture) process.stderr.write(result.stderr || result.stdout); throw new Error(`Remote Wrangler ${args[0]} failed`) }
  return result.stdout
}
wrangler(['d1', 'migrations', 'apply', 'DB', '--remote', '--config', configFile])
const output = wrangler(mode !== 'production'
  ? ['preview', '--config', configFile, '--name', mode === 'main' ? 'main' : branch, '--ignore-base-config', '--secrets-file', secretFile, '--json']
  : ['deploy', '--config', configFile, '--secrets-file', secretFile], true)
process.stdout.write(output)
if (mode !== 'production') {
  const data = JSON.parse(output.slice(output.indexOf('{')))
  const url = data.preview?.urls?.find(value => {
    const candidate = new URL(value)
    return candidate.protocol === 'https:' && /^[a-z0-9-]+\.dev\.llll\.gg$/.test(candidate.hostname)
  })
  if (!url) throw new Error('Cloudflare did not return a Preview URL under *.dev.llll.gg')
  let verified = false
  for (let attempt = 0; attempt < 12; attempt++) {
    const response = await fetch(`${url}/api/health`).catch(() => null)
    if (response?.ok && (await response.json()).commit === sourceCommit) { verified = true; break }
    await new Promise(resolveWait => setTimeout(resolveWait, 2000))
  }
  if (!verified) throw new Error('Deployed Preview verification failed')
  console.log(mode === 'main' ? `Verified main Preview at ${sourceCommit}: ${url}` : `Verified PR ${pr.number} Preview: ${url}`)
}

if (mode === 'production') {
  let verified = false
  for (let attempt = 0; attempt < 15; attempt++) {
    const response = await fetch('https://llll.gg/api/health').catch(() => null)
    const health = response?.ok ? await response.json() : null
    if (health?.commit === production.commit && health?.version === production.version) { verified = true; break }
    await new Promise(resolveWait => setTimeout(resolveWait, 2000))
  }
  if (!verified) throw new Error('Released production version did not become healthy')
  console.log(`Verified production ${production.tag}: ${production.commit}`)
}
