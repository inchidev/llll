import { spawnSync } from 'node:child_process'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { requireWorkersBuild } from './ci-only.mjs'
import { isolatedPreviewBindings, nativeServerPreviewOrigin } from './server-preview-config.mjs'
import { compareVersions, parseVersion } from './release-policy.mjs'
import { findD1Database } from './cloudflare-d1.mjs'
import {
  pullRequestCandidate,
  verifyMergeParents,
} from './pull-request-ref.mjs'
requireWorkersBuild()
const root = resolve(import.meta.dirname, '..')
const branch = process.env.WORKERS_CI_BRANCH
if (!branch) throw new Error('A Server Preview requires a Workers Builds branch')
// main has one standing Preview, `main`: everything merged, before any release. It keeps
// its own database, so migrations accumulate as they do on a Server that updates.
const mainPreview = branch === 'main'
function git(args) {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  if (r.status !== 0) throw new Error('Cannot verify PR Git refs')
  return r.stdout
}
const repo = 'https://github.com/inchidev/llll.git'
const sourceCommit = process.env.WORKERS_CI_COMMIT_SHA || git(['rev-parse', 'HEAD']).trim()
let candidate = null
if (mainPreview) {
  // An older main Build must not replace a newer one.
  const head = git(['ls-remote', repo, 'refs/heads/main']).split(/\s/)[0]
  if (head !== sourceCommit) throw new Error('The main Preview deploys only the current head of main')
} else {
  candidate = pullRequestCandidate(
    git(['ls-remote', repo, 'refs/heads/main', `refs/heads/${branch}`, 'refs/pull/*']),
    branch,
    sourceCommit,
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
}
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
const prNumber = candidate?.number
const databaseName = mainPreview ? 'llll-server-main' : process.env.LLLL_PREVIEW_DATABASE || `llll-server-pr-${prNumber}`
if (!mainPreview && !new RegExp(`^llll-server-pr-${prNumber}(?:-[a-z0-9]+(?:-[a-z0-9]+)*)?$`).test(databaseName))
  throw new Error('A per-PR Preview database must belong to this PR')
async function ensureStagingResource(kind, list, create, name) {
  let resource
  if (kind === 'd1') resource = await findD1Database(async path => ({ result: await api(path) }), name)
  else {
    const listed = await api(kind === 'kv' ? '/storage/kv/namespaces?per_page=100' : '/r2/buckets?per_page=100')
    resource = (listed.buckets || listed).find(item => item.name === name || item.title === name)
  }
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
// Only the staging parent is deployed here; it has no data bindings or base routing.
wrangler(['deploy', '--config', resolve(root, 'wrangler.preview-parent.jsonc')])
const previewPath = '/workers/workers/llll-server/previews'
const previews = await api(`${previewPath}?name=${encodeURIComponent(branch)}&per_page=100`)
const preview = previews.find(item => item.name === branch)
  || await api(previewPath, 'POST', { name: branch })
const previewOrigin = nativeServerPreviewOrigin(preview)
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
    PUBLIC_ORIGIN: previewOrigin,
    ADMIN_EMAIL: process.env.LLLL_PREVIEW_ADMIN_EMAIL || 'owner@example.com',
    AUTH_REGISTRATION_MODE: 'invite_only',
    EMBED_ORIGINS: mainPreview ? 'https://main.dev.llll.gg' : process.env.LLLL_PREVIEW_SHELL_ORIGIN || 'https://llll.gg',
    ACCOUNT_ID: account,
    // Every app response carries Server-Timing for D1 and Durable Object waits.
    SERVER_TIMING: '1',
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
config.previews = isolatedPreviewBindings(config)
const auth = process.env.LLLL_PREVIEW_AUTH_SECRET,
  claim = process.env.LLLL_PREVIEW_SETUP_TOKEN,
  // Optional, as in Docker and Coolify: a new Preview database starts with this Owner, so no claim is needed.
  adminPassword = process.env.LLLL_PREVIEW_ADMIN_PASSWORD
if (!auth || !claim)
  throw new Error('Configure private Preview auth and owner claims')
if (adminPassword && adminPassword.length < 12)
  throw new Error('LLLL_PREVIEW_ADMIN_PASSWORD must be at least 12 characters')
const dir = resolve(root, '.deployment/builds')
await mkdir(dir, { recursive: true })
const file = resolve(dir, 'server-preview.json'),
  secrets = resolve(dir, 'server-preview-secrets.json')
await writeFile(file, JSON.stringify(config))
await writeFile(
  secrets,
  JSON.stringify({ AUTH_SECRET: auth, SETUP_TOKEN: claim, ...(adminPassword ? { ADMIN_PASSWORD: adminPassword } : {}) }),
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
// Repair the old script's placeholder only; real operator-selected origins stay intact.
await api(`/d1/database/${db.uuid}/query`, 'POST', {
  sql: 'UPDATE server_domains SET origin = ?, hostname = ? WHERE origin = ?',
  params: [previewOrigin, new URL(previewOrigin).hostname, 'https://server-preview.dev.llll.gg'],
})
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
const url = nativeServerPreviewOrigin(data.preview)
if (url !== previewOrigin) throw new Error('The Server Preview URL changed during deployment')
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
console.log(mainPreview ? `main Server Preview verified at ${sourceCommit}: ${url}` : `Server Preview verified for PR #${prNumber}: ${url}`)
