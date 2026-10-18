import { requireWorkersBuild } from './ci-only.mjs'
// User-operated Cloudflare installer. Agents deploy through the connected API tool.
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { randomBytes, createHash } from 'node:crypto'
requireWorkersBuild()
const root = resolve(import.meta.dirname, '..')
const id = process.env.INSTALLATION_ID || 'community'
if (!/^[a-z][a-z0-9-]{0,31}$/.test(id)) throw new Error('INSTALLATION_ID must be a lowercase name of up to 32 characters')
const worker = `llll-${id}`
const account = process.env.CLOUDFLARE_ACCOUNT_ID
const token = process.env.CLOUDFLARE_API_TOKEN
const file = resolve(root, '.deployment', `${id}.json`)
if (process.argv.includes('--dry-run')) {
  console.log(JSON.stringify({ worker, database: `${worker}-control`, backupBucket: `${worker}-backups`, stateFile: file, source: '.installer/deployment/llll-deployment.json', account: account || 'CLOUDFLARE_ACCOUNT_ID', steps: ['Check account and existing deployment', 'Create or reuse control D1 and separate backup bucket', 'Apply pending serialized installation migrations', 'Upload verified local build assets and installation module', 'Enable workers.dev and daily control backups', 'Print private owner claim URL'] }, null, 2))
  process.exit(0)
}
if (!account || !/^[a-f0-9]{32}$/.test(account) || !token) throw new Error('Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN in an ignored .env file')
async function api(path, method = 'GET', body, credential = token) {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, { method, headers: { Authorization: `Bearer ${credential}`, ...(body instanceof FormData || body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body) })
  const data = await response.json()
  if (!response.ok || !data.success) throw Object.assign(new Error(`Cloudflare ${method} ${path}: ${data.errors?.map(error => error.message).join('; ') || response.status}`), { status: response.status })
  return data
}
const artifact = JSON.parse(await readFile(resolve(root, '.installer/deployment/llll-deployment.json'), 'utf8'))
for (const module of Object.values(artifact.modules)) if (createHash('sha256').update(module.content).digest('hex') !== module.sha256) throw new Error('Deployment module integrity check failed')
if (artifact.schemaVersion !== 1) throw new Error('Unsupported deployment artifact')
const subdomain = (await api(`/accounts/${account}/workers/subdomain`)).result.subdomain
const origin = `https://${worker}.${subdomain}.workers.dev`
let saved
try { saved = JSON.parse(await readFile(file, 'utf8')) }
catch (error) { if (error.code !== 'ENOENT') throw error }
let existing = []
let workerExists
try { workerExists = true; existing = (await api(`/accounts/${account}/workers/scripts/${worker}/settings`)).result.bindings || [] }
catch (error) { if (error.status !== 404) throw error; workerExists = false }
if (!saved && workerExists) throw new Error('Worker already exists. Restore its private deployment state before updating; do not replace its secrets.')
if (saved && (typeof saved.authSecret !== 'string' || !/^[a-f0-9]{64}$/.test(saved.authSecret) || typeof saved.setupToken !== 'string' || !/^[a-f0-9]{64}$/.test(saved.setupToken))) throw new Error('Saved deployment secrets are invalid; restore the original state file')
if (saved && (saved.accountId !== account || saved.worker !== worker || saved.origin !== origin)) throw new Error('Saved state belongs to a different deployment')
if (!saved) {
  saved = { accountId: account, worker, origin, authSecret: randomBytes(32).toString('hex'), setupToken: randomBytes(32).toString('hex') }
  await mkdir(resolve(root, '.deployment'), { recursive: true })
  await writeFile(file, JSON.stringify(saved, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
}
const databaseName = `${worker}-control`
let database = (await api(`/accounts/${account}/d1/database?name=${encodeURIComponent(databaseName)}&per_page=100`)).result.find(value => value.name === databaseName)
if (!database) database = (await api(`/accounts/${account}/d1/database`, 'POST', { name: databaseName })).result
const bucket = `${worker}-backups`
const buckets = (await api(`/accounts/${account}/r2/buckets?name_contains=${encodeURIComponent(bucket)}`)).result.buckets
if (!buckets.some(value => value.name === bucket)) await api(`/accounts/${account}/r2/buckets`, 'POST', { name: bucket })
const query = sql => api(`/accounts/${account}/d1/database/${database.uuid}/query`, 'POST', { sql })
await query('CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL UNIQUE,applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);')
const applied = new Set((await query('SELECT name FROM d1_migrations;')).result[0].results.map(row => row.name))
for (const migration of artifact.migrations.installation) {
  if (!/^[0-9]{4}_[a-z0-9_]+\.sql$/.test(migration.name)) throw new Error('Invalid migration name')
  if (!applied.has(migration.name)) await query(migration.sql + `\nINSERT INTO d1_migrations(name) VALUES ('${migration.name}');`)
}
const manifest = Object.fromEntries(artifact.assets.map(asset => [asset.path, { hash: asset.hash, size: asset.size }]))
const session = (await api(`/accounts/${account}/workers/scripts/${worker}/assets-upload-session`, 'POST', { manifest })).result
let completion = session.buckets?.length ? undefined : session.jwt
const byHash = new Map(artifact.assets.map(asset => [asset.hash, asset]))
for (const batch of session.buckets || []) {
  const form = new FormData()
  for (const hash of batch) { const asset = byHash.get(hash); if (!asset) throw new Error('Provider requested an unknown asset'); form.append(hash, new Blob([asset.contentBase64], { type: asset.contentType }), hash) }
  const uploaded = (await api(`/accounts/${account}/workers/assets/upload?base64=true`, 'POST', form, session.jwt)).result
  completion = uploaded.jwt || completion
}
if (!completion) throw new Error('Asset upload did not complete')
const vars = { PUBLIC_ORIGIN: origin, INSTALLATION_ID: id, INSTALLATION_NAME: process.env.INSTALLATION_NAME || 'My L4', REGISTRATION_MODE: 'invite_only', CLIENT_ORIGINS: process.env.CLIENT_ORIGINS || 'https://llll.gg', EMBED_ORIGINS: process.env.EMBED_ORIGINS || 'https://llll.gg', BACKUP_BUCKET_NAME: bucket, RELEASE_MANIFEST: `https://github.com/inchidev/llll/releases/download/v${artifact.version}/llll-cloudflare-manifest.json` }
const bindings = [{ name: 'INSTALLATION_DB', type: 'd1', database_id: database.uuid }, { name: 'BACKUPS', type: 'r2_bucket', bucket_name: bucket }, { name: 'ASSETS', type: 'assets' }, ...Object.entries(vars).map(([name, text]) => ({ name, text, type: 'plain_text' })), { name: 'AUTH_SECRET', text: saved.authSecret, type: 'secret_text' }, { name: 'SETUP_TOKEN', text: saved.setupToken, type: 'secret_text' }]
const replaced = new Set(bindings.map(binding => binding.name))
bindings.push(...existing.filter(binding => !replaced.has(binding.name)).map(binding => ({ name: binding.name, type: 'inherit' })))
const metadata = { main_module: 'installation.mjs', compatibility_date: '2026-09-26', compatibility_flags: ['nodejs_compat', 'global_fetch_strictly_public'], bindings, assets: { jwt: completion, config: { html_handling: 'none', not_found_handling: 'single-page-application', run_worker_first: true } }, observability: { enabled: true, redact_query_string: true } }
const form = new FormData()
form.append('metadata', JSON.stringify(metadata))
form.append('installation.mjs', new Blob([artifact.modules.installation.content], { type: 'application/javascript+module' }), 'installation.mjs')
await api(`/accounts/${account}/workers/scripts/${worker}`, 'PUT', form)
await api(`/accounts/${account}/workers/scripts/${worker}/subdomain`, 'POST', { enabled: true, previews_enabled: false })
await api(`/accounts/${account}/workers/scripts/${worker}/schedules`, 'PUT', [{ cron: '23 3 * * *' }])
console.log(`Installation: ${origin}\nPrivate owner setup: ${origin}/connections#claim=${saved.setupToken}\nKeep ${file} private and backed up. Connect provisioning credentials in Instance settings when needed. Attach a custom domain through Cloudflare and update PUBLIC_ORIGIN before using it.`)
