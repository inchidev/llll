import { spawnSync } from 'node:child_process'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { requireWorkersBuild } from './ci-only.mjs'
import { compareVersions, parseVersion } from './release-policy.mjs'
import {
  pullRequestCandidate,
  verifyMergeParents,
} from './pull-request-ref.mjs'
requireWorkersBuild()
const root = resolve(import.meta.dirname, '..')
const branch = process.env.WORKERS_CI_BRANCH
if (!branch || branch === 'main')
  throw new Error('An isolated Server Preview requires a PR branch')
function git(args) {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  if (r.status !== 0) throw new Error('Cannot verify PR Git refs')
  return r.stdout
}
const repo = 'https://github.com/inchidev/llll.git'
const candidate = pullRequestCandidate(
  git([
    'ls-remote',
    repo,
    'refs/heads/main',
    `refs/heads/${branch}`,
    'refs/pull/*',
  ]),
  branch,
  process.env.WORKERS_CI_COMMIT_SHA || git(['rev-parse', 'HEAD']).trim(),
)
if (!candidate)
  throw new Error(
    'Server Preview requires the current head of an open mergeable PR',
  )
git([
  'fetch',
  '--no-tags',
  '--depth=1',
  repo,
  `refs/pull/${candidate.number}/merge`,
])
if (!verifyMergeParents(git(['cat-file', '-p', 'FETCH_HEAD']), candidate))
  throw new Error('Server Preview merge parents did not match')
const account = process.env.CLOUDFLARE_ACCOUNT_ID,
  token = process.env.CLOUDFLARE_API_TOKEN
if (!account || !token) throw new Error('Workers Builds credentials are missing')
async function api(path, method = 'GET', body) {
  const r = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${account}${path}`,
    {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
  )
  const d = await r.json()
  if (!r.ok || !d.success)
    throw new Error(`Cloudflare administration failed (${r.status}): ${path}`)
  return d.result
}
// Native Worker Previews deploy one staging Server Worker per PR. Previews are
// never created from a developer machine; this script runs inside Workers Builds.
const base = JSON.parse(
  (await readFile(resolve(root, 'wrangler.jsonc'), 'utf8')).replace(
    /^\s*\/\/.*$/gm,
    '',
  ),
)
if (base.name !== 'llll-server') throw new Error('The Server build config must target the staging Server Worker')
// A fresh isolated database can replace an obsolete, unmerged PR schema.
// The shared staging database stays available for every other Preview.
const prNumber = candidate.number
const databaseName = process.env.LLLL_PREVIEW_DATABASE || `llll-server-pr-${prNumber}`
if (!new RegExp(`^llll-server-pr-${prNumber}(?:-[a-z0-9]+(?:-[a-z0-9]+)*)?$`).test(databaseName))
  throw new Error('A per-PR Preview database must belong to this PR')
async function ensureStagingResource(kind, list, create, name) {
  let resource = (await api(kind === 'd1' ? '/d1/database?per_page=100' : kind === 'kv' ? '/storage/kv/namespaces?per_page=100' : '/r2/buckets?per_page=100'))
  const items = resource.buckets || resource
  resource = items.find((item) => item.name === name || item.title === name)
  resource ||= await api(kind === 'd1' ? '/d1/database' : kind === 'kv' ? '/storage/kv/namespaces' : '/r2/buckets', 'POST', create)
  list.push(resource)
  return resource
}
const staging = { d1: [], r2: [], kv: [] }
const db = await ensureStagingResource('d1', staging.d1, { name: databaseName }, databaseName)
const files = await ensureStagingResource('r2', staging.r2, { name: `llll-server-staging-files` }, 'llll-server-staging-files')
const backups = await ensureStagingResource('r2', staging.r2, { name: `llll-server-staging-backups` }, 'llll-server-staging-backups')
const tickets = await ensureStagingResource('kv', staging.kv, { title: 'llll-server-staging-tickets' }, 'llll-server-staging-tickets')
if (backups.name === files.name) throw new Error('Backup destination must be separate from live files')
const config = {
  ...base,
  main: resolve(root, '.output/server/index.mjs'),
  workers_dev: false,
  preview_urls: false,
  assets: {
    ...base.assets,
    directory: resolve(root, '.output/public'),
  },
  d1_databases: [
    {
      binding: 'DB',
      database_name: db.name,
      database_id: db.uuid,
      migrations_dir: resolve(root, 'drizzle/server-migrations'),
    },
  ],
  r2_buckets: [
    { binding: 'FILES', bucket_name: files.name },
    { binding: 'BACKUPS', bucket_name: backups.name },
  ],
  kv_namespaces: [{ binding: 'TICKETS', id: tickets.id }],
  // Previews do not inherit vars from production; declare every required one.
  vars: {
    PUBLIC_ORIGIN: 'https://server-preview.dev.llll.gg',
    ADMIN_EMAIL: 'owner@example.com',
    AUTH_REGISTRATION_MODE: 'invite_only',
    EMBED_ORIGINS: process.env.LLLL_PREVIEW_SHELL_ORIGIN || 'https://llll.gg',
    ACCOUNT_ID: account,
  },
  // DO state is isolated per Preview and deleted with it; each binding must be
  // declared here or the Preview fails with error 1101.
  previews: {
    ...(base.previews || {}),
    durable_objects: { bindings: base.durable_objects.bindings },
  },
}
if (process.env.LLLL_PREVIEW_UPDATE_FIXTURE === '1') {
  const version = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')).version
  const installed = process.env.LLLL_PREVIEW_INSTALLED_VERSION || version
  parseVersion(installed)
  if (compareVersions(installed, version) > 0) throw new Error('A Preview fixture cannot impersonate a newer release')
  // Version stays a local fixture override only; the updater reads discovery.
  Object.assign(config.vars, { LLLL_VERSION: installed })
}
const auth = process.env.LLLL_PREVIEW_AUTH_SECRET,
  claim = process.env.LLLL_PREVIEW_SETUP_TOKEN
if (!auth || !claim)
  throw new Error('Configure private Preview auth and owner claims')
const dir = resolve(root, '.deployment/builds')
await mkdir(dir, { recursive: true })
const file = resolve(dir, 'server-preview.json'),
  secrets = resolve(dir, 'server-preview-secrets.json')
await writeFile(file, JSON.stringify(config))
await writeFile(
  secrets,
  JSON.stringify({ AUTH_SECRET: auth, SETUP_TOKEN: claim }),
  { mode: 0o600 },
)
function wrangler(args) {
  const r = spawnSync('pnpm', ['exec', 'wrangler', ...args], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (r.status !== 0) {
    process.stderr.write(r.stderr || r.stdout || '')
    throw new Error('Workers Builds Server Preview deployment failed')
  }
  return r.stdout
}
wrangler(['d1', 'migrations', 'apply', 'DB', '--remote', '--config', file])
const output = wrangler([
  'preview',
  '--config',
  file,
  '--name',
  branch,
  '--ignore-base-config',
  '--secrets-file',
  secrets,
  '--json',
])
const data = JSON.parse(output.slice(output.indexOf('{')))
const url = data.preview?.urls?.find((value) => {
  try {
    const candidate = new URL(value)
    return candidate.protocol === 'https:' && candidate.hostname.endsWith('.workers.dev') ? candidate : false
  }
  catch {
    return false
  }
}) || data.preview?.urls?.[0]
if (!url) throw new Error('Cloudflare did not return a Preview URL')
let verified = false
for (let attempt = 0; attempt < 150; attempt++) {
  const check = await fetch(url + '/.well-known/llll', {
    signal: AbortSignal.timeout(10000),
  }).catch(() => null)
  const d = check?.ok ? await check.json().catch(() => null) : null
  const aliases = d?.aliases || []
  if (d?.kind === 'server' && (d.origin === url || aliases.includes(url))) {
    verified = true
    break
  }
  await new Promise((resolveWait) => setTimeout(resolveWait, 2000))
}
if (!verified) throw new Error('Server Preview discovery verification failed')
console.log(`Server Preview verified for PR #${prNumber}: ${url}`)
