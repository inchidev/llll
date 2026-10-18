import { spawnSync } from 'node:child_process'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { requireWorkersBuild } from './ci-only.mjs'
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
  process.env.WORKERS_CI_COMMIT_SHA,
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
const name = process.env.LLLL_PREVIEW_WORKER,
  origin = process.env.LLLL_PREVIEW_ORIGIN
if (
  !account ||
  !token ||
  !/^llll-server-pr-\d+$/.test(name || '') ||
  name !== `llll-server-pr-${candidate.number}` ||
  !origin
)
  throw new Error('Configure this PR’s isolated Server Preview target')
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
let db = (await api('/d1/database?per_page=100')).find((d) => d.name === name)
db ||= await api('/d1/database', 'POST', { name })
for (const bucket of [name + '-files', name + '-backups']) {
  const listed = await api('/r2/buckets?name_contains=' + bucket)
  if (!listed.buckets.some((b) => b.name === bucket))
    await api('/r2/buckets', 'POST', { name: bucket })
}
let kv = (await api('/storage/kv/namespaces?per_page=100')).find(
  (k) => k.title === name + '-tickets',
)
kv ||= await api('/storage/kv/namespaces', 'POST', { title: name + '-tickets' })
const config = JSON.parse(
  (await readFile(resolve(root, 'wrangler.dev.jsonc'), 'utf8')).replace(
    /^\s*\/\/.*$/gm,
    '',
  ),
)
Object.assign(config, {
  name,
  main: resolve(root, '.output/server/index.mjs'),
  workers_dev: false,
  preview_urls: false,
  assets: {
    directory: resolve(root, '.output/public'),
    binding: 'ASSETS',
    not_found_handling: 'single-page-application',
    run_worker_first: true,
  },
  d1_databases: [
    {
      binding: 'DB',
      database_name: name,
      database_id: db.uuid,
      migrations_dir: resolve(root, 'drizzle/migrations'),
    },
  ],
  r2_buckets: [
    { binding: 'FILES', bucket_name: name + '-files' },
    { binding: 'BACKUPS', bucket_name: name + '-backups' },
  ],
  kv_namespaces: [{ binding: 'TICKETS', id: kv.id }],
  vars: {
    PUBLIC_ORIGIN: origin,
    APP_NAME: 'L4 Preview',
    ADMIN_EMAIL: 'owner@example.com',
    AUTH_REGISTRATION_MODE: 'invite_only',
    EMBED_ORIGINS: process.env.LLLL_PREVIEW_SHELL_ORIGIN || 'https://llll.gg',
  },
})
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
    stdio: 'inherit',
  })
  if (r.status !== 0)
    throw new Error('Workers Builds Server Preview deployment failed')
}
wrangler(['d1', 'migrations', 'apply', 'DB', '--remote', '--config', file])
wrangler(['deploy', '--config', file, '--secrets-file', secrets])
// Cloudflare only permits attaching a custom domain after the first deployment.
if (process.env.LLLL_PREVIEW_ZONE_ID) {
  await api('/workers/domains', 'PUT', {
    hostname: new URL(origin).hostname,
    service: name,
    zone_id: process.env.LLLL_PREVIEW_ZONE_ID,
    enabled: true,
    previews_enabled: false,
  })
}
let verified = false
for (let attempt = 0; attempt < 30; attempt++) {
  const check = await fetch(origin + '/.well-known/llll', {
    signal: AbortSignal.timeout(10000),
  }).catch(() => null)
  const d = check?.ok ? await check.json().catch(() => null) : null
  if (d?.kind === 'server' && d.origin === origin) {
    verified = true
    break
  }
  await new Promise((resolveWait) => setTimeout(resolveWait, 2000))
}
if (!verified) throw new Error('Server Preview discovery verification failed')
console.log(`Server Preview verified for PR #${candidate.number}: ${origin}`)
