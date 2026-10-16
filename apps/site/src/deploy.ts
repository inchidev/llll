import { encryptSecret } from '../../../shared/encrypted-secret'
import { refreshCloudflareGrant, randomCode } from '../../../shared/cloudflare-oauth'
import type { PortalEnv } from './env'
import type { DeploymentState } from './session'
import { digest } from './session'

/** Releases come from published GitHub tags, never from a pinned env URL.
 * The operator configures no version: the user picks one on `/deploy` and the
 * portal verifies it against that release's own `SHA256SUMS` plus per-module
 * hashes. Published tags and assets are immutable; a repair needs a new version.
 */
export const RELEASE_REPO = 'inchidev/llll'
export const VERSION_PATTERN = /^v\d+\.\d+\.\d+$/
const ARTIFACT_FILE = 'llll-deployment.json'
const MANIFEST_FILE = 'llll-cloudflare-manifest.json'
type Asset = { path: string; hash: string; size: number; contentType: string; contentBase64: string }
type Artifact = { schemaVersion: number; version: string; modules: Record<string, { content: string; sha256: string }>; assets: Asset[]; migrations: { installation: { name: string; sql: string }[] } }
export async function cloudflare<T>(token: string, path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch('https://api.cloudflare.com/client/v4' + path, {
    method, redirect: 'manual', headers: { Authorization: `Bearer ${token}`, ...(body instanceof FormData || body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body), signal: AbortSignal.timeout(30000),
  })
  let data: { success: boolean; result: T; errors?: { code?: number | string; message?: string }[] }
  try { data = await response.json() as typeof data }
  catch { throw new Error(`Cloudflare could not complete ${method} ${path.split('?')[0]} (${response.status}): unreadable response. Check account permissions and service activation.`) }
  if (!response.ok || !data.success) {
    const detail = (data.errors || []).map(e => [e.code, e.message].filter(Boolean).join(' ')).filter(Boolean).join('; ')
    throw new Error(`Cloudflare could not complete ${method} ${path.split('?')[0]} (${response.status})${detail ? `: ${detail}` : '. Check account permissions and service activation.'}`)
  }
  return data.result
}
export type ReleaseInfo = { version: string; name: string; published_at: string; notes_url: string }

function releaseBase(version: string) {
  if (!VERSION_PATTERN.test(version)) throw new Error('Choose a published release version')
  return `https://github.com/${RELEASE_REPO}/releases/download/${version}`
}

/** Published (non-draft) releases with deployment artifacts, newest first.
 * A `GITHUB_TOKEN` (any PAT, no scopes needed for public repos) avoids GitHub
 * API rate limits on shared Cloudflare egress IPs. Without it the portal uses
 * the unauthenticated quota.
 */
export async function listReleases(token?: string): Promise<ReleaseInfo[]> {
  const response = await fetch(`https://api.github.com/repos/${RELEASE_REPO}/releases?per_page=30`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'llll-portal', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, signal: AbortSignal.timeout(20000),
  })
  if (!response.ok) throw new Error(`The release list could not be loaded from GitHub (${response.status})`)
  const data = await response.json() as { tag_name?: string; name?: string; draft?: boolean; prerelease?: boolean; published_at?: string; html_url?: string; assets?: { name?: string }[] }[]
  return data
    .filter(release => !release.draft && !release.prerelease && typeof release.tag_name === 'string' && VERSION_PATTERN.test(release.tag_name)
      && [ARTIFACT_FILE, MANIFEST_FILE, 'SHA256SUMS'].every(name => release.assets?.some(asset => asset.name === name)))
    .map(release => ({ version: release.tag_name!, name: release.name || release.tag_name!, published_at: release.published_at || '', notes_url: release.html_url || '' }))
}

async function downloadBytes(url: string, limit: number, what: string) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30000) })
  if (!response.ok || !response.body) throw new Error(`The release ${what} could not be downloaded`)
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let length = 0
  while (true) { const { done, value } = await reader.read(); if (done) break; length += value.length; if (length > limit) { await reader.cancel(); throw new Error(`Release ${what} exceeds the installer size limit`) } chunks.push(value) }
  const bytes = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
  return bytes
}

async function release(version: string): Promise<{ artifact: Artifact; manifestUrl: string }> {
  const base = releaseBase(version)
  const sums = new TextDecoder().decode(await downloadBytes(base + '/SHA256SUMS', 1024 * 1024, 'checksums'))
  const expected = sums.split('\n').map(line => line.trim().split(/\s+/)).find(([, file]) => file === ARTIFACT_FILE || file === `./${ARTIFACT_FILE}`)?.[0]
  if (!expected || !/^[a-f0-9]{64}$/.test(expected)) throw new Error('The release checksums do not cover the deployment bundle')
  const bytes = await downloadBytes(`${base}/${ARTIFACT_FILE}`, 64 * 1024 * 1024, 'bundle')
  const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(v => v.toString(16).padStart(2, '0')).join('')
  if (hash !== expected) throw new Error('Release checksum did not match')
  const artifact = JSON.parse(new TextDecoder().decode(bytes)) as Artifact
  if (artifact.schemaVersion !== 1 || artifact.version !== version.slice(1) || !artifact.modules.installation || !Array.isArray(artifact.assets)) throw new Error('The release bundle does not match the selected version')
  for (const module of Object.values(artifact.modules)) if (await digest(module.content) !== module.sha256) throw new Error('Release module checksum did not match')
  return { artifact, manifestUrl: `${base}/${MANIFEST_FILE}` }
}

/** Each completed phase is resumable. Persisted names and secrets never change on retry. */
export async function advanceDeployment(state: DeploymentState, env: PortalEnv, save: () => Promise<void>) {
  if (!state.grant || !state.accountId || !state.version || !state.worker || !state.authSecret || !state.setupToken) throw new Error('Start the deployment first')
  if (state.grant.expiresAt < Date.now() + 120000) { state.grant = await refreshCloudflareGrant(state.grant); await save() }
  const token = state.grant.accessToken
  const account = `/accounts/${state.accountId}`
  const { artifact, manifestUrl } = await release(state.version)
  const api = <T>(path: string, method = 'GET', body?: unknown) => cloudflare<T>(token, account + path, method, body)
  if (state.databaseId && state.step && state.step > 0) {
    const encrypted = JSON.stringify(await encryptSecret(state.authSecret, 'settings:CLOUDFLARE_OAUTH_GRANT', JSON.stringify(state.grant)))
    await api(`/d1/database/${state.databaseId}/query`, 'POST', { sql: 'UPDATE integration_settings SET value=? WHERE key=?', params: [encrypted, 'CLOUDFLARE_OAUTH_GRANT'] })
  }
  if (state.step === 0) {
    const subdomain = await api<{ subdomain: string }>('/workers/subdomain')
    state.origin = `https://${state.worker}.${subdomain.subdomain}.workers.dev`
    const name = state.worker + '-control'
    const existing = await api<{ uuid: string; name: string }[]>('/d1/database?name=' + name)
    state.databaseId = existing.find(d => d.name === name)?.uuid || (await api<{ uuid: string }>('/d1/database', 'POST', { name })).uuid
    await save()
    state.bucket = state.worker + '-backups'
    const buckets = await api<{ buckets: { name: string }[] }>('/r2/buckets?name_contains=' + state.bucket)
    if (!buckets.buckets.some(b => b.name === state.bucket)) await api('/r2/buckets', 'POST', { name: state.bucket })
    const query = (sql: string, params?: unknown[]) => api<{ results: { name: string }[] }[]>(`/d1/database/${state.databaseId}/query`, 'POST', { sql, params })
    await query('CREATE TABLE IF NOT EXISTS d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL UNIQUE,applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);')
    const applied = new Set((await query('SELECT name FROM d1_migrations'))[0]!.results.map(row => row.name))
    for (const migration of artifact.migrations.installation) {
      if (!/^\d{4}_[a-z0-9_]+\.sql$/.test(migration.name)) throw new Error('Invalid migration name')
      if (!applied.has(migration.name)) await query(migration.sql + `\nINSERT INTO d1_migrations(name) VALUES ('${migration.name}');`)
    }
    for (const [key, value] of Object.entries({ CLOUDFLARE_ACCOUNT_ID: state.accountId, CLOUDFLARE_OAUTH_GRANT: JSON.stringify(state.grant) })) {
      const encrypted = JSON.stringify(await encryptSecret(state.authSecret, `settings:${key}`, value))
      await query('INSERT INTO integration_settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', [key, encrypted])
    }
    state.step = 1; await save(); return
  }
  if (state.step === 1) {
    const manifest = Object.fromEntries(artifact.assets.map(a => [a.path, { hash: a.hash, size: a.size }]))
    const session = await api<{ jwt: string; buckets?: string[][] }>(`/workers/scripts/${state.worker}/assets-upload-session`, 'POST', { manifest })
    let completion = session.buckets?.length ? '' : session.jwt
    const byHash = new Map(artifact.assets.map(a => [a.hash, a]))
    for (const batch of session.buckets || []) {
      const form = new FormData()
      for (const hash of batch) { const asset = byHash.get(hash); if (!asset) throw new Error('Unknown asset requested'); form.append(hash, new Blob([asset.contentBase64], { type: asset.contentType }), hash) }
      completion = (await cloudflare<{ jwt: string }>(session.jwt, account + '/workers/assets/upload?base64=true', 'POST', form)).jwt || completion
    }
    if (!completion) throw new Error('Asset upload did not finish')
    const variables = { PUBLIC_ORIGIN: state.origin!, INSTALLATION_ID: state.installationId!, INSTALLATION_NAME: state.name!, REGISTRATION_MODE: 'invite_only', EMBED_ORIGINS: env.PUBLIC_ORIGIN, CLIENT_ORIGINS: env.PUBLIC_ORIGIN, BACKUP_BUCKET_NAME: state.bucket!, RELEASE_MANIFEST: manifestUrl }
    const bindings = [{ name: 'INSTALLATION_DB', type: 'd1', id: state.databaseId }, { name: 'BACKUPS', type: 'r2_bucket', bucket_name: state.bucket }, { name: 'ASSETS', type: 'assets' }, ...Object.entries(variables).map(([name, text]) => ({ name, type: 'plain_text', text })), ...Object.entries({ AUTH_SECRET: state.authSecret, SETUP_TOKEN: state.setupToken }).map(([name, text]) => ({ name, type: 'secret_text', text }))]
    const metadata = { main_module: 'installation.mjs', compatibility_date: '2026-10-16', compatibility_flags: ['nodejs_compat'], bindings, assets: { jwt: completion, config: { html_handling: 'none', not_found_handling: 'single-page-application', run_worker_first: true } }, observability: { enabled: true, redact_query_string: true } }
    const form = new FormData(); form.append('metadata', JSON.stringify(metadata)); form.append('installation.mjs', new Blob([artifact.modules.installation!.content], { type: 'application/javascript+module' }), 'installation.mjs')
    await api(`/workers/scripts/${state.worker}`, 'PUT', form)
    await api(`/workers/scripts/${state.worker}/subdomain`, 'POST', { enabled: true, previews_enabled: false })
    await api(`/workers/scripts/${state.worker}/schedules`, 'PUT', [{ cron: '23 3 * * *' }])
    state.step = 2; await save(); return
  }
  if (state.step === 2) {
    const check = await fetch(state.origin + '/.well-known/llll', { redirect: 'manual', signal: AbortSignal.timeout(15000) })
    const data = await check.json() as { product: string; origin: string; ready: boolean }
    if (!check.ok || data.product !== 'llll' || data.origin !== state.origin || data.ready) throw new Error('Installation verification failed; retry before claiming ownership')
    // The installation now owns the grant. The portal keeps no Cloudflare credential.
    delete state.grant; delete state.authSecret; delete state.verifier; delete state.state
    state.completed = true; state.step = 3; await save()
  }
}

export function deploymentParameters(accountId: string, name: string, version: string) {
  if (!VERSION_PATTERN.test(version)) throw new Error('Choose a published release version')
  const installationId = crypto.randomUUID()
  return { accountId, name, version, worker: 'llll-' + installationId, installationId, authSecret: randomCode(), setupToken: randomCode(), step: 0 }
}
