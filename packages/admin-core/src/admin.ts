import { cloudflareApi, cloudflareClient } from './cloudflare-client.js'
import { ensureWorkersHostname } from './access.js'
import { CONTROL_BINDING_NAMES, ensureD1, uploadAssets, workerObservability, type ExistingWorkerBinding } from './deploy.js'
import { durableObjectMigrations } from './migrations.js'
import { createError } from './errors.js'
import { patchWorkerBindings } from './worker-settings.js'
import { ADMIN_BINDING, ADMIN_WORKER_NAME, workspaceAdminBinding, type WorkspaceAdminLink } from './admin-link.js'
import type { AdminRelease, DeployProgressReporter } from './types.js'

/** Marks a Worker as a L4 Admin. */
export const adminMarker = 'llll.gg/admin/v1'
const ADMIN_SCHEDULE = '*/15 * * * *'

export type AdminDeployInput = {
  accountId: string
  /** Defaults to `llll-admin`. */
  workerName?: string
  /** Public Cloudflare OAuth client used to refresh the Admin's own grant. */
  oauthClientId?: string
  /** Where the Admin reports its heartbeat, when it was created from a L4 Account. */
  directory?: { endpoint: string, id: string, token: string }
  /** Only for a new Admin, or to hand over a new credential or claim to an existing one. */
  secrets?: {
    claimToken?: string
    oauthRefreshToken?: string
  }
}

export type AdminDeployResult = {
  origin: string
  workerName: string
  version: string
  updated: boolean
  claimUrl?: string
}

export type L4Admin = {
  workerName: string
  origin: string
  version: string | null
}

type AdminWorker = { exists: boolean, migrationTag?: string, bindings: ExistingWorkerBinding[] }

function isAdmin(bindings: ExistingWorkerBinding[]) {
  return bindings.some(binding => binding.name === 'LLLL_ADMIN_INSTALLATION' && binding.type === 'plain_text' && binding.text === adminMarker)
}

async function inspectAdmin(client: ReturnType<typeof cloudflareClient>, accountId: string, workerName: string): Promise<AdminWorker> {
  for await (const worker of client.workers.scripts.list({ account_id: accountId })) {
    if (worker.id !== workerName) continue
    const settings = await client.workers.scripts.scriptAndVersionSettings.get(workerName, { account_id: accountId })
    const bindings = (settings.bindings || []) as ExistingWorkerBinding[]
    if (!isAdmin(bindings)) throw createError({ statusCode: 409, statusMessage: `A Worker named ${workerName} already exists and is not a L4 Admin` })
    return { exists: true, migrationTag: worker.migration_tag, bindings }
  }
  return { exists: false, bindings: [] }
}

function randomSecret(bytes = 48) {
  const value = new Uint8Array(bytes)
  crypto.getRandomValues(value)
  let binary = ''
  for (const byte of value) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

function adminBindings(
  input: AdminDeployInput,
  workerName: string,
  release: AdminRelease,
  databaseId: string,
  existing: AdminWorker,
): Array<Record<string, unknown>> {
  const replaced = new Set([
    'ASSETS',
    'LLLL_VERSION',
    ...release.manifest.durableObjects.map(item => item.binding),
  ])
  const bindings: Array<Record<string, unknown>> = []
  const set = (binding: Record<string, unknown>) => {
    replaced.add(String(binding.name))
    bindings.push(binding)
  }
  set({ type: 'assets', name: 'ASSETS' })
  set({ type: 'plain_text', name: 'LLLL_VERSION', text: release.manifest.version })
  for (const item of release.manifest.durableObjects) {
    const current = existing.bindings.some(binding => binding.name === item.binding)
    set(current ? { type: 'inherit', name: item.binding } : { type: 'durable_object_namespace', name: item.binding, class_name: item.className })
  }
  if (!existing.exists) {
    set({ type: 'plain_text', name: 'LLLL_ADMIN_INSTALLATION', text: adminMarker })
    set({ type: 'plain_text', name: 'ADMIN_WORKER_NAME', text: workerName })
    set({ type: 'plain_text', name: 'CLOUDFLARE_ACCOUNT_ID', text: input.accountId })
    set({ type: 'd1', name: 'ADMIN_DB', database_id: databaseId })
    set({ type: 'secret_text', name: 'ADMIN_SECRET', text: randomSecret() })
  }
  if (input.oauthClientId) set({ type: 'plain_text', name: 'CLOUDFLARE_OAUTH_CLIENT_ID', text: input.oauthClientId })
  if (input.directory) {
    set({ type: 'plain_text', name: 'LLLL_DIRECTORY_ENDPOINT', text: input.directory.endpoint })
    set({ type: 'plain_text', name: 'LLLL_DIRECTORY_ID', text: input.directory.id })
    set({ type: 'secret_text', name: 'LLLL_DIRECTORY_TOKEN', text: input.directory.token })
  }
  if (input.secrets?.claimToken) set({ type: 'secret_text', name: 'ADMIN_CLAIM_TOKEN', text: input.secrets.claimToken })
  if (input.secrets?.oauthRefreshToken) set({ type: 'secret_text', name: 'CLOUDFLARE_OAUTH_REFRESH_TOKEN', text: input.secrets.oauthRefreshToken })
  for (const binding of existing.bindings) {
    if (binding.name && !replaced.has(binding.name)) bindings.push({ type: 'inherit', name: binding.name })
  }
  return bindings
}

async function verifyAdmin(origin: string, version: string, report?: DeployProgressReporter) {
  let lastFailure = ''
  // A new workers.dev hostname can take a minute or two to resolve.
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await report?.({ type: 'progress', step: 'verify', state: 'active', detail: `Attempt ${attempt + 1}` })
    if (attempt) await new Promise(resolve => setTimeout(resolve, 3_000))
    try {
      const response = await fetch(`${origin}/api/health`, { headers: { Accept: 'application/json' }, redirect: 'manual', cache: 'no-store' })
      if (!response.ok) {
        lastFailure = `HTTP ${response.status}`
        continue
      }
      const health = await response.json() as { version?: string, ok?: boolean }
      if (health.ok && health.version === version) return
      lastFailure = `health response was not ready for ${version}`
    }
    catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error)
    }
  }
  throw createError({ statusCode: 502, statusMessage: `The L4 Admin was deployed, but its health check did not pass: ${lastFailure}` })
}

/**
 * Create the account's L4 Admin, or update it in place. A new Admin
 * gets its own D1 database and encryption secret; later deploys keep every
 * existing binding and only replace code, assets, and the secrets passed in.
 */
export async function deployL4Admin(
  accessToken: string,
  input: AdminDeployInput,
  release: AdminRelease,
  report?: DeployProgressReporter,
  /** An Admin updating itself cannot reach its own hostname, so it skips the health check. */
  options: { verify?: boolean } = {},
): Promise<AdminDeployResult> {
  const progress = (step: 'account' | 'storage' | 'assets' | 'worker' | 'domain' | 'schedule' | 'verify', state: 'active' | 'complete', detail?: string) =>
    report?.({ type: 'progress', step, state, detail })
  const workerName = input.workerName || ADMIN_WORKER_NAME
  const client = cloudflareClient(accessToken)

  await progress('account', 'active')
  const account = await client.accounts.get({ account_id: input.accountId })
  if (account.id !== input.accountId) throw createError({ statusCode: 403, statusMessage: 'Cloudflare account is unavailable' })
  const existing = await inspectAdmin(client, input.accountId, workerName)
  await progress('account', 'complete', existing.exists ? 'Updating the existing Admin' : account.name || undefined)

  await progress('storage', 'active')
  const databaseId = existing.exists ? '' : await ensureD1(client, input.accountId, `${workerName}-db`)
  await progress('storage', 'complete')

  await progress('assets', 'active')
  const assetsJwt = await uploadAssets(accessToken, input.accountId, workerName, release.assets)
  await progress('assets', 'complete')

  await progress('worker', 'active')
  const metadata: Record<string, unknown> = {
    main_module: 'llll-admin.mjs',
    compatibility_date: release.manifest.compatibilityDate,
    compatibility_flags: release.manifest.compatibilityFlags,
    bindings: adminBindings(input, workerName, release, databaseId, existing),
    assets: { jwt: assetsJwt },
    observability: workerObservability,
    annotations: {
      'workers/message': `L4 Admin ${release.manifest.version}`,
      'workers/tag': `llll-admin-${release.manifest.version}`,
    },
  }
  const migrations = durableObjectMigrations(release.manifest, existing)
  if (migrations) metadata.migrations = migrations
  if (existing.exists) metadata.keep_bindings = ['secret_text']
  const form = new FormData()
  form.append('metadata', JSON.stringify(metadata))
  form.append('llll-admin.mjs', new Blob([release.worker], { type: 'application/javascript+module' }), 'llll-admin.mjs')
  await cloudflareApi(
    accessToken,
    `/accounts/${input.accountId}/workers/scripts/${workerName}?excludeScript=true&bindings_inherit=strict`,
    { method: 'PUT', body: form },
  )
  await progress('worker', 'complete', `L4 Admin ${release.manifest.version}`)

  await progress('domain', 'active')
  await client.workers.scripts.subdomain.create(workerName, { account_id: input.accountId, enabled: true, previews_enabled: false })
  const origin = `https://${await ensureWorkersHostname(client, input.accountId, workerName)}`
  await progress('domain', 'complete', origin)

  await progress('schedule', 'active')
  await client.workers.scripts.schedules.update(workerName, { account_id: input.accountId, body: [{ cron: ADMIN_SCHEDULE }] })
  await progress('schedule', 'complete')

  if (options.verify !== false) {
    await progress('verify', 'active')
    await verifyAdmin(origin, release.manifest.version, report)
    await progress('verify', 'complete', 'Admin health verified')
  }
  const claimToken = input.secrets?.claimToken
  return {
    origin,
    workerName,
    version: release.manifest.version,
    updated: existing.exists,
    ...(claimToken ? { claimUrl: `${origin}/claim#token=${encodeURIComponent(claimToken)}` } : {}),
  }
}

/** The account's L4 Admin, if one is deployed. */
export async function findL4Admin(accessToken: string, accountId: string): Promise<L4Admin | null> {
  const client = cloudflareClient(accessToken)
  for await (const worker of client.workers.scripts.list({ account_id: accountId })) {
    if (!worker.id) continue
    const settings = await client.workers.scripts.scriptAndVersionSettings.get(worker.id, { account_id: accountId }).catch(() => null)
    const bindings = (settings?.bindings || []) as ExistingWorkerBinding[]
    if (!isAdmin(bindings)) continue
    const version = bindings.find(binding => binding.name === 'LLLL_VERSION' && binding.type === 'plain_text')?.text || null
    const origin = `https://${await ensureWorkersHostname(client, accountId, worker.id)}`
    return { workerName: worker.id, origin, version }
  }
  return null
}

/**
 * Link an existing workspace to the Admin: add `LLLL_ADMIN` and remove
 * the Installation Control Credential. Everything else is left as it is.
 */
export async function adoptL4Workspace(
  accessToken: string,
  accountId: string,
  workerName: string,
  admin: WorkspaceAdminLink,
): Promise<void> {
  const client = cloudflareClient(accessToken)
  const settings = await client.workers.scripts.scriptAndVersionSettings.get(workerName, { account_id: accountId })
  const current = (settings.bindings || []) as ExistingWorkerBinding[]
  const removed = new Set([ADMIN_BINDING, ...CONTROL_BINDING_NAMES])
  const kept = current
    .filter(binding => binding.name && !removed.has(binding.name))
    .map(binding => ({ type: 'inherit', name: binding.name }))
  await patchWorkerBindings(accessToken, accountId, workerName, [...kept, workspaceAdminBinding(workerName, admin)])
}
