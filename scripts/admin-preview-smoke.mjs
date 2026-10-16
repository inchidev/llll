import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { verifyAdminRecovery } from './admin-recovery-smoke.mjs'

// The Preview job supplies its scoped credential. Never use local Wrangler login.
if (process.env.GITHUB_ACTIONS !== 'true') throw new Error('This isolated deployment smoke runs only in GitHub Actions')
const root = resolve(import.meta.dirname, '..')
const account = process.env.CLOUDFLARE_ACCOUNT_ID || ''
const apiToken = process.env.CLOUDFLARE_API_TOKEN || ''
const run = process.env.GITHUB_RUN_ID || ''
const attempt = process.env.GITHUB_RUN_ATTEMPT || '1'
if (!/^[0-9a-f]{32}$/u.test(account) || !apiToken || !/^\d+$/u.test(run) || !/^\d+$/u.test(attempt)) throw new Error('Preview account, credential and run ID are required')
const name = `llll-admin-smoke-${run}-${attempt}`
const claim = randomBytes(32).toString('hex')
const directory = join(root, '.preview', 'admin-smoke')
const config = join(directory, 'wrangler.json')
const secrets = join(directory, 'secrets.json')
let databaseId

async function api(path, method = 'GET', body) {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}${path}`, {
    method,
    headers: { Authorization: `Bearer ${apiToken}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const payload = await response.json()
  if (!response.ok || payload.success === false) throw new Error(`Cloudflare ${method} ${path}: HTTP ${response.status}`)
  return payload.result
}

try {
  const subdomain = (await api('/workers/subdomain')).subdomain
  if (!subdomain) throw new Error('Preview account has no workers.dev subdomain')
  databaseId = (await api('/d1/database', 'POST', { name: `${name}-db` })).uuid
  if (!databaseId) throw new Error('Preview D1 ID is missing')
  await mkdir(directory, { recursive: true })
  await writeFile(config, JSON.stringify({
    name, account_id: account, workers_dev: true, preview_urls: false,
    main: join(root, 'apps/admin/.output/server/index.mjs'),
    compatibility_date: '2026-09-28', compatibility_flags: ['nodejs_compat'],
    assets: { directory: join(root, 'apps/admin/.output/public'), binding: 'ASSETS' },
    d1_databases: [{ binding: 'ADMIN_DB', database_name: `${name}-db`, database_id: databaseId }],
    durable_objects: { bindings: [{ name: 'COORDINATOR', class_name: 'AdminCoordinator' }] },
    migrations: [{ tag: 'v1', new_sqlite_classes: ['AdminCoordinator'] }],
    vars: { CLOUDFLARE_ACCOUNT_ID: account, ADMIN_WORKER_NAME: name },
  }))
  await writeFile(secrets, JSON.stringify({ ADMIN_SECRET: randomBytes(32).toString('hex'), ADMIN_CLAIM_TOKEN: claim }), { mode: 0o600 })
  const deployed = spawnSync('pnpm', ['exec', 'wrangler', 'deploy', '--config', config, '--secrets-file', secrets], {
    cwd: root, encoding: 'utf8', env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
  })
  // Wrangler masks secret bindings. No request payloads or recovery codes are logged.
  if (deployed.stdout) process.stdout.write(deployed.stdout)
  if (deployed.stderr) process.stderr.write(deployed.stderr)
  if (deployed.error || deployed.status !== 0) throw new Error('Admin Preview deployment failed')
  const origin = `https://${name}.${subdomain}.workers.dev`
  let healthy = false
  for (let retry = 0; retry < 20; retry++) {
    try {
      const response = await fetch(`${origin}/api/health`)
      if (response.ok && (await response.json()).ok) { healthy = true; break }
    }
    catch { /* DNS and deployment propagation */ }
    await new Promise(resolve => setTimeout(resolve, 3000))
  }
  if (!healthy) throw new Error('Admin Preview did not become healthy')
  await verifyAdminRecovery(origin, claim)
}
finally {
  // This Worker and database are unique to this run and contain only test data.
  const outcomes = await Promise.allSettled([
    api(`/workers/scripts/${name}?force=true`, 'DELETE'),
    ...(databaseId ? [api(`/d1/database/${databaseId}`, 'DELETE')] : []),
  ])
  for (const outcome of outcomes) if (outcome.status === 'rejected') console.error(`::error::Admin Preview cleanup failed: ${outcome.reason.message}`)
  if (outcomes.some(outcome => outcome.status === 'rejected')) process.exitCode = 1
}
