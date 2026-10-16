import type Cloudflare from 'cloudflare'
import type { DeployProgressReporter, DeployProgressStep, DeployRequest, InstallationControl, InstallerAssetsPayload, InstallerReleaseManifest } from './types.js'
import { cloudflareApi, cloudflareClient } from './cloudflare-client.js'
import { createError } from './errors.js'
import { durableObjectMigrations } from './migrations.js'
import { randomBase64Url } from './random.js'
import { ensureCloudflareAccess, ensureWorkersHostname } from './access.js'
import { ensurePrimaryMail } from './primary-mail.js'
import { ADMIN_CAPABILITY, workspaceAdminBinding, type WorkspaceAdminLink } from './admin-link.js'

export type ExistingWorkerBinding = {
  name: string
  type: string
  text?: string
  class_name?: string
  database_id?: string
  bucket_name?: string
  namespace_id?: string
  service?: string
}

type ExistingWorker = {
  exists: boolean
  migrationTag?: string
  mailZoneId?: string
  mailDomain?: string
  appHostname?: string
  customDomainEnabled?: boolean
  databaseId?: string
  bucketName?: string
  kvId?: string
  telemetryId?: string
  authMode?: 'access' | 'builtin'
  accessIssuer?: string
  accessAudience?: string
  accessApplicationId?: string
  accessHealthApplicationId?: string
  accessDeletionApplicationId?: string
  primary?: boolean
  lifecycleBindingNames?: string[]
  bindings?: ExistingWorkerBinding[]
}

type EmailRoutingSettings = { enabled?: boolean; status?: string }
type EmailCatchAll = { enabled?: boolean; actions?: Array<{ type?: string; value?: string[] }> }
type DnsRecord = { name?: string; content?: string; type?: string }
type SendingSubdomain = { name: string; enabled: boolean }
type WorkerDomain = { hostname: string; service: string }
type WorkerSearchResult = { id?: string, script_name?: string }
export type DeploymentHealth = {
  version?: string
  ok?: boolean
  ready?: boolean
  users?: number
  migrated?: boolean
  ownerSetup?: boolean
}

export const workerObservability = {
  enabled: true,
  redact_query_string: true,
  logs: {
    enabled: true,
    invocation_logs: true,
    head_sampling_rate: 1,
    persist: true,
  },
  traces: {
    enabled: true,
    head_sampling_rate: 0.1,
    persist: true,
  },
} as const

export function requiresReadyVerification(existing: boolean, authMode: DeployRequest['authMode'], previousHealth: DeploymentHealth | null): boolean {
  if (!existing || authMode === 'access') return false
  return !(previousHealth?.ownerSetup === true && previousHealth.users === 0)
}

async function readDeploymentHealth(origin: string): Promise<DeploymentHealth | null> {
  try {
    const response = await fetch(`${origin}/api/setup/health`, {
      headers: { Accept: 'application/json' },
      redirect: 'manual',
      cache: 'no-store',
    })
    return response.ok ? await response.json() as DeploymentHealth : null
  }
  catch {
    return null
  }
}

export const installerMarker = 'llll.gg/v1'
const bootstrapMarker = 'llll.gg/bootstrap/v1'

/** Domain and mail routes already belong to a discovered installation and are not part of a version upgrade. */
export function requiresInitialInfrastructureProvisioning(existing: boolean): boolean {
  return !existing
}

function mailDomain(request: DeployRequest) {
  return `${request.mailSubdomain}.${request.zoneName}`
}

export function isL4Worker(bindings: ExistingWorkerBinding[]) {
  const marker = bindings.find(binding => binding.name === 'LLLL_INSTALLATION')
  return marker?.type === 'plain_text' && marker.text === installerMarker
}

async function inspectWorker(client: Cloudflare, accountId: string, workerName: string): Promise<ExistingWorker> {
  for await (const worker of client.workers.scripts.list({ account_id: accountId })) {
    if (worker.id !== workerName) continue
    const settings = await client.workers.scripts.scriptAndVersionSettings.get(workerName, { account_id: accountId })
    const bindings = settings.bindings as ExistingWorkerBinding[] || []
    const marker = bindings.find(binding => binding.name === 'LLLL_INSTALLATION')
    if (marker?.type === 'plain_text' && marker.text === bootstrapMarker) return { exists: false }
    if (!isL4Worker(bindings)) {
      throw createError({ statusCode: 409, statusMessage: `A non-L4 Worker named ${workerName} already exists` })
    }
    const text = (name: string) => bindings.find(binding => binding.name === name && binding.type === 'plain_text')?.text
    const lifecycleBindingNames = [
      'LLLL_ADMIN',
      'LLLL_CONTROL_ID',
      'LLLL_CONTROL_ENDPOINT',
      'LLLL_CONTROL_TOKEN',
      'LLLL_EMAIL_DOMAINS',
      'LLLL_APP_ZONE_ID',
      'LLLL_APP_ZONE_NAME',
    ].filter(name => bindings.some(binding => binding.name === name))
    return {
      exists: true,
      migrationTag: worker.migration_tag,
      mailZoneId: text('MAIL_ZONE_ID'),
      mailDomain: text('MAIL_DOMAIN'),
      appHostname: text('LLLL_APP_HOSTNAME') || text('MAIL_APP_HOSTNAME'),
      customDomainEnabled: text('LLLL_CUSTOM_DOMAIN') === 'true',
      databaseId: bindings.find(binding => binding.name === 'DB' && binding.type === 'd1')?.database_id,
      bucketName: bindings.find(binding => binding.name === 'FILES' && binding.type === 'r2_bucket')?.bucket_name,
      kvId: bindings.find(binding => binding.name === 'TICKETS' && binding.type === 'kv_namespace')?.namespace_id,
      telemetryId: text('LLLL_TELEMETRY_ID'),
      authMode: text('AUTH_MODE') === 'access' ? 'access' : 'builtin',
      accessIssuer: text('CF_ACCESS_ISS'),
      accessAudience: text('CF_ACCESS_AUD'),
      accessApplicationId: text('CF_ACCESS_APP_ID'),
      accessHealthApplicationId: text('CF_ACCESS_HEALTH_APP_ID'),
      accessDeletionApplicationId: text('CF_ACCESS_DELETION_APP_ID'),
      primary: text('LLLL_PRIMARY') === 'true',
      lifecycleBindingNames,
      bindings,
    }
  }
  return { exists: false }
}

async function primaryWorker(client: Cloudflare, accountId: string): Promise<string | null> {
  for await (const worker of client.workers.scripts.list({ account_id: accountId })) {
    if (!worker.id) continue
    const settings = await client.workers.scripts.scriptAndVersionSettings.get(worker.id, { account_id: accountId })
    const bindings = settings.bindings as ExistingWorkerBinding[] || []
    const marker = bindings.find(binding => binding.name === 'LLLL_INSTALLATION')
    const primary = bindings.find(binding => binding.name === 'LLLL_PRIMARY')
    if (marker?.type === 'plain_text' && marker.text === installerMarker && primary?.text === 'true') return worker.id
  }
  return null
}

export async function ensureD1(client: Cloudflare, accountId: string, name: string) {
  for await (const database of client.d1.database.list({ account_id: accountId, name })) {
    if (database.name === name && database.uuid) return database.uuid
  }
  const database = await client.d1.database.create({ account_id: accountId, name })
  if (!database.uuid) throw createError({ statusCode: 502, statusMessage: 'Cloudflare did not return the D1 database ID' })
  return database.uuid
}

export async function ensureR2(client: Cloudflare, accountId: string, name: string) {
  let cursor: string | undefined
  do {
    const page = await client.r2.buckets.list({ account_id: accountId, name_contains: name, cursor })
    if (page.buckets?.some(bucket => bucket.name === name)) return name
    cursor = (page as { cursor?: string }).cursor
  } while (cursor)
  await client.r2.buckets.create({ account_id: accountId, name })
  return name
}

async function ensureKv(client: Cloudflare, accountId: string, title: string) {
  for await (const namespace of client.kv.namespaces.list({ account_id: accountId, per_page: 100 })) {
    if (namespace.title === title) return namespace.id
  }
  return (await client.kv.namespaces.create({ account_id: accountId, title })).id
}

export async function provisionWorkspaceStorage(client: Cloudflare, request: Pick<DeployRequest, 'accountId' | 'workerName' | 'filesEnabled'>, existing: Pick<ExistingWorker, 'exists' | 'databaseId' | 'bucketName' | 'kvId'>) {
  const [databaseId, bucketName, kvId] = existing.exists
    ? [existing.databaseId, existing.bucketName, existing.kvId]
    : await Promise.all([
        ensureD1(client, request.accountId, `${request.workerName}-db`),
        request.filesEnabled !== false ? ensureR2(client, request.accountId, `${request.workerName}-files`) : undefined,
        ensureKv(client, request.accountId, `${request.workerName}-tickets`),
      ])
  if (!databaseId || !kvId) throw createError({ statusCode: 409, statusMessage: 'Existing L4 storage bindings are incomplete' })
  return { databaseId, bucketName, kvId }
}

async function assertDomainAvailable(accessToken: string, request: DeployRequest) {
  if (request.customDomainEnabled) {
    const hostname = `${request.appSubdomain}.${request.zoneName}`
    const domains = await cloudflareApi<WorkerDomain[]>(accessToken, `/accounts/${request.accountId}/workers/domains`)
    const attached = domains.find(domain => domain.hostname.toLowerCase() === hostname)
    if (attached && attached.service !== request.workerName) {
      throw createError({ statusCode: 409, statusMessage: `${hostname} is already attached to Worker ${attached.service}` })
    }
  }
  if (!request.mailEnabled) return

  const requestedMailDomain = mailDomain(request)
  const [mxRecords, routing] = await Promise.all([
    cloudflareApi<DnsRecord[]>(accessToken, `/zones/${request.zoneId}/dns_records?type=MX&name=${encodeURIComponent(requestedMailDomain)}&per_page=100`),
    cloudflareApi<EmailRoutingSettings>(accessToken, `/zones/${request.zoneId}/email/routing`),
  ])
  const foreignMx = mxRecords.filter(record => !String(record.content || '').toLowerCase().endsWith('.mx.cloudflare.net'))
  if (foreignMx.length) {
    throw createError({
      statusCode: 409,
      statusMessage: `${requestedMailDomain} already has mail exchange records. L4 will not replace another mail provider.`,
    })
  }
  if (routing.enabled) {
    const catchAll = await cloudflareApi<EmailCatchAll>(accessToken, `/zones/${request.zoneId}/email/routing/rules/catch_all`)
    const target = catchAll.actions?.find(action => action.type === 'worker')?.value?.[0]
    if (catchAll.enabled && target && target !== request.workerName) {
      throw createError({ statusCode: 409, statusMessage: `${request.zoneName} already routes catch-all email to Worker ${target}` })
    }
    if (catchAll.enabled && !target) {
      throw createError({ statusCode: 409, statusMessage: `${request.zoneName} already has a catch-all email rule. L4 will not replace it.` })
    }
  }
}

async function ensureEmailRouting(accessToken: string, request: DeployRequest) {
  const requestedMailDomain = mailDomain(request)
  const mxRecords = await cloudflareApi<DnsRecord[]>(
    accessToken,
    `/zones/${request.zoneId}/dns_records?type=MX&name=${encodeURIComponent(requestedMailDomain)}&per_page=100`,
  )
  if (mxRecords.some(record => String(record.content || '').toLowerCase().endsWith('.mx.cloudflare.net'))) return
  await cloudflareApi(accessToken, `/zones/${request.zoneId}/email/routing/dns`, {
    method: 'POST',
    body: JSON.stringify({ name: requestedMailDomain }),
  })
}

async function ensureEmailSending(accessToken: string, request: DeployRequest) {
  const requestedMailDomain = mailDomain(request)
  const domains = await cloudflareApi<SendingSubdomain[]>(accessToken, `/zones/${request.zoneId}/email/sending/subdomains`)
  if (domains.some(domain => domain.name.toLowerCase() === requestedMailDomain && domain.enabled)) return
  await cloudflareApi(accessToken, `/zones/${request.zoneId}/email/sending/subdomains`, {
    method: 'POST',
    body: JSON.stringify({ name: requestedMailDomain }),
  })
}

async function attachAppDomain(accessToken: string, request: DeployRequest) {
  await cloudflareApi(accessToken, `/accounts/${request.accountId}/workers/domains`, {
    method: 'PUT',
    body: JSON.stringify({
      hostname: `${request.appSubdomain}.${request.zoneName}`,
      service: request.workerName,
      zone_id: request.zoneId,
      zone_name: request.zoneName,
    }),
  })
}

async function attachMailCatchAll(accessToken: string, request: DeployRequest, primaryWorkerName: string) {
  await cloudflareApi(accessToken, `/zones/${request.zoneId}/email/routing/rules/catch_all`, {
    method: 'PUT',
    body: JSON.stringify({
      name: `L4 primary workspace mail for ${request.zoneName}`,
      enabled: true,
      matchers: [{ type: 'all' }],
      actions: [{ type: 'worker', value: [primaryWorkerName] }],
    }),
  })
}

function sqlString(value: string) {
  return `'${value.replaceAll("'", "''")}'`
}

async function applyD1Migrations(accessToken: string, accountId: string, databaseId: string, payload: InstallerAssetsPayload) {
  const names = new Set<string>()
  for (const migration of payload.migrations) {
    if (!/^[0-9A-Za-z_.-]+$/.test(migration.name)) {
      throw createError({ statusCode: 502, statusMessage: `L4 migration ${migration.name} has an invalid name` })
    }
    if (names.has(migration.name)) {
      throw createError({ statusCode: 502, statusMessage: `L4 migration ${migration.name} is duplicated` })
    }
    names.add(migration.name)
  }

  await cloudflareApi(accessToken, `/accounts/${accountId}/d1/database/${databaseId}/query`, {
    method: 'POST',
    body: JSON.stringify({ sql: 'CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);' }),
  })
  const rows = await cloudflareApi<Array<{ results?: Array<{ name?: string }> }>>(
    accessToken,
    `/accounts/${accountId}/d1/database/${databaseId}/query`,
    { method: 'POST', body: JSON.stringify({ sql: 'SELECT name FROM d1_migrations;' }) },
  )
  const applied = new Set(rows.flatMap(result => result.results || []).map(row => row.name).filter(Boolean))
  const pending = payload.migrations.filter(migration => !applied.has(migration.name))
  if (pending.length) {
    // One subrequest for every pending migration: free plans cap a Worker
    // invocation at 50 subrequests, which per-migration calls exhaust.
    const sql = pending
      .map(migration => `${migration.sql.replaceAll('--> statement-breakpoint', '\n')}\nINSERT INTO d1_migrations (name) VALUES (${sqlString(migration.name)});`)
      .join('\n')
    const results = await cloudflareApi<Array<{ success?: boolean }>>(accessToken, `/accounts/${accountId}/d1/database/${databaseId}/query`, {
      method: 'POST',
      body: JSON.stringify({ sql }),
    })
    // D1 returns one result per SQL statement (each migration holds many), so
    // only inspect per-statement success here.
    if (results.some(statement => statement.success === false)) {
      throw createError({ statusCode: 502, statusMessage: 'L4 migration did not complete' })
    }
  }
  return pending.map(migration => migration.name)
}

export async function uploadAssets(accessToken: string, accountId: string, workerName: string, payload: InstallerAssetsPayload) {
  const manifest = Object.fromEntries(payload.assets.map(asset => [asset.path, { hash: asset.hash, size: asset.size }]))
  const session = await cloudflareApi<{ jwt: string, buckets?: string[][] }>(
    accessToken,
    `/accounts/${accountId}/workers/scripts/${workerName}/assets-upload-session`,
    { method: 'POST', body: JSON.stringify({ manifest }) },
  )
  let completionToken = session.buckets?.length ? undefined : session.jwt
  const byHash = new Map(payload.assets.map(asset => [asset.hash, asset]))
  for (const bucket of session.buckets || []) {
    const form = new FormData()
    for (const hash of bucket) {
      const asset = byHash.get(hash)
      if (!asset) throw createError({ statusCode: 502, statusMessage: 'Cloudflare requested an unknown release asset' })
      form.append(hash, new Blob([asset.contentBase64], { type: asset.contentType }), hash)
    }
    const response = await cloudflareApi<{ jwt?: string }>(
      session.jwt,
      `/accounts/${accountId}/workers/assets/upload?base64=true`,
      { method: 'POST', body: form },
    )
    if (response.jwt) completionToken = response.jwt
  }
  if (!completionToken) throw createError({ statusCode: 502, statusMessage: 'Cloudflare did not finish the static asset upload' })
  return completionToken
}

async function ensureBootstrapWorkerTarget(accessToken: string, accountId: string, workerName: string, compatibilityDate: string) {
  const metadata = {
    main_module: 'llll-bootstrap.mjs',
    compatibility_date: compatibilityDate,
    bindings: [{ type: 'plain_text', name: 'LLLL_INSTALLATION', text: bootstrapMarker }],
  }
  const source = "export default { fetch() { return new Response('L4 is being installed.', { status: 503 }) } }"
  const form = new FormData()
  form.append('metadata', JSON.stringify(metadata))
  form.append('llll-bootstrap.mjs', new Blob([source], { type: 'application/javascript+module' }), 'llll-bootstrap.mjs')
  await cloudflareApi(
    accessToken,
    `/accounts/${accountId}/workers/scripts/${workerName}?excludeScript=true&bindings_inherit=strict`,
    { method: 'PUT', body: form },
  )
  const workers = await cloudflareApi<WorkerSearchResult[]>(
    accessToken,
    `/accounts/${accountId}/workers/scripts-search?name=${encodeURIComponent(workerName)}`,
  )
  const workerId = workers.find(worker => worker.script_name === workerName)?.id
  if (!workerId) throw createError({ statusCode: 502, statusMessage: 'Cloudflare did not return the Worker ID required by Access' })
  return workerId
}

async function uploadWorker(
  accessToken: string,
  accountId: string,
  request: DeployRequest,
  manifest: InstallerReleaseManifest,
  worker: ArrayBuffer,
  resources: { databaseId: string, bucketName: string | undefined, kvId: string, assetsJwt: string, origin: string },
  existing: ExistingWorker,
  ownerSetupToken: string | null,
  telemetry: { installationId: string, token: string },
  access: { issuer: string, audience: string, applicationId: string, healthApplicationId: string, deletionApplicationId: string } | null,
  primary: boolean,
  admin: WorkspaceAdminLink | null,
  control?: InstallationControl,
) {
  if (request.backupBucketName) {
    if (request.backupBucketName === resources.bucketName) throw createError({ statusCode: 400, statusMessage: 'Backup bucket must be separate from live files' })
    await ensureR2(cloudflareClient(accessToken), accountId, request.backupBucketName)
  }
  const hostname = new URL(resources.origin).hostname
  const bindings: Array<Record<string, unknown>> = [
    { type: 'd1', name: 'DB', database_id: resources.databaseId },
    { type: 'kv_namespace', name: 'TICKETS', namespace_id: resources.kvId },
    { type: 'ai', name: 'AI' },
    { type: 'browser', name: 'BROWSER' },
    { type: 'assets', name: 'ASSETS' },
    { type: 'plain_text', name: 'PUBLIC_ORIGIN', text: resources.origin },
    { type: 'plain_text', name: 'APP_NAME', text: request.appName },
    { type: 'plain_text', name: 'ADMIN_WORKSPACE', text: request.appName },
    { type: 'plain_text', name: 'APP_TITLE', text: 'One workspace for humans and agents.' },
    { type: 'plain_text', name: 'APP_SUBTITLE', text: 'Built on your Cloudflare stack.' },
    { type: 'plain_text', name: 'AUTH_REGISTRATION_MODE', text: request.registrationMode },
    { type: 'plain_text', name: 'AUTH_MODE', text: request.authMode },
    { type: 'plain_text', name: 'AGENT_MODEL', text: '@cf/moonshotai/kimi-k2.7-code' },
    { type: 'plain_text', name: 'LLLL_APP_HOSTNAME', text: hostname },
    { type: 'plain_text', name: 'LLLL_ACCOUNT_ID', text: accountId },
    { type: 'plain_text', name: 'LLLL_WORKER_NAME', text: request.workerName },
    { type: 'plain_text', name: 'LLLL_CUSTOM_DOMAIN', text: request.customDomainEnabled ? 'true' : 'false' },
    { type: 'plain_text', name: 'LLLL_INSTALLATION', text: installerMarker },
    { type: 'plain_text', name: 'LLLL_VERSION', text: manifest.version },
    { type: 'plain_text', name: 'LLLL_TELEMETRY_ID', text: telemetry.installationId },
    { type: 'plain_text', name: 'LLLL_TELEMETRY_ENDPOINT', text: 'https://llll.gg/api/telemetry/heartbeat' },
    { type: 'secret_text', name: 'LLLL_TELEMETRY_TOKEN', text: telemetry.token },
    ...manifest.durableObjects.map(item => ({ type: 'durable_object_namespace', name: item.binding, class_name: item.className })),
  ]
  if (request.backupBucketName) bindings.push({ type: 'r2_bucket', name: 'BACKUPS', bucket_name: request.backupBucketName }, { type: 'plain_text', name: 'BACKUP_BUCKET_NAME', text: request.backupBucketName })
  if (resources.bucketName) bindings.push({ type: 'r2_bucket', name: 'FILES', bucket_name: resources.bucketName })
  if (admin) bindings.push(workspaceAdminBinding(request.workerName, admin))
  if (control && !admin) {
    bindings.push(
      { type: 'plain_text', name: 'LLLL_CONTROL_ID', text: control.id },
      { type: 'plain_text', name: 'LLLL_CONTROL_ENDPOINT', text: control.endpoint },
      { type: 'secret_text', name: 'LLLL_CONTROL_TOKEN', text: control.token },
    )
  }
  if (request.customDomainEnabled || request.mailEnabled) {
    bindings.push(
      { type: 'plain_text', name: 'LLLL_ZONE_ID', text: request.zoneId },
      { type: 'plain_text', name: 'LLLL_ZONE_NAME', text: request.zoneName },
      { type: 'plain_text', name: 'LLLL_APP_SUBDOMAIN', text: request.appSubdomain },
    )
  }
  if (primary) bindings.push({ type: 'plain_text', name: 'LLLL_PRIMARY', text: 'true' })
  if (access) {
    bindings.push(
      { type: 'plain_text', name: 'CF_ACCESS_ISS', text: access.issuer },
      { type: 'plain_text', name: 'CF_ACCESS_AUD', text: access.audience },
      { type: 'plain_text', name: 'CF_ACCESS_APP_ID', text: access.applicationId },
      { type: 'plain_text', name: 'CF_ACCESS_HEALTH_APP_ID', text: access.healthApplicationId },
      { type: 'plain_text', name: 'CF_ACCESS_DELETION_APP_ID', text: access.deletionApplicationId },
    )
  }
  if (request.mailEnabled) {
    bindings.push(
      { type: 'send_email', name: 'MAIL_EMAIL' },
      { type: 'plain_text', name: 'LLLL_MAIL_ROUTES', text: '[]' },
      { type: 'plain_text', name: 'MAIL_DOMAIN', text: mailDomain(request) },
      { type: 'plain_text', name: 'MAIL_ZONE_ID', text: request.zoneId },
      { type: 'plain_text', name: 'MAIL_APP_HOSTNAME', text: hostname },
      { type: 'plain_text', name: 'MAIL_DEFAULT_LOCAL_PART', text: request.mailLocalPart },
    )
  }
  if (!existing.exists) {
    bindings.push(
      { type: 'secret_text', name: 'AUTH_SECRET', text: randomBase64Url(48) },
      { type: 'secret_text', name: 'ADMIN_EMAIL', text: request.adminEmail },
    )
    if (ownerSetupToken) bindings.push({ type: 'secret_text', name: 'ADMIN_SETUP_TOKEN', text: ownerSetupToken })
  }

  const definedBindings = new Set(bindings.map(binding => String(binding.name)))
  // An Admin replaces the Installation Control Credential, so those bindings are not carried over.
  const dropped = new Set(admin ? CONTROL_BINDING_NAMES : [])
  for (const name of existing.lifecycleBindingNames || []) {
    if (!definedBindings.has(name) && !dropped.has(name)) bindings.push({ type: 'inherit', name })
  }

  const migrations = durableObjectMigrations(manifest, existing)
  const metadata: Record<string, unknown> = {
    main_module: 'llll-worker.mjs',
    compatibility_date: manifest.compatibilityDate,
    compatibility_flags: manifest.compatibilityFlags,
    bindings,
    assets: { jwt: resources.assetsJwt, config: { html_handling: 'none' } },
    observability: workerObservability,
    annotations: {
      'workers/message': `L4 ${manifest.version} via installer`,
      'workers/tag': `llll-${manifest.version}`,
    },
  }
  if (migrations) metadata.migrations = migrations
  if (existing.exists) metadata.keep_bindings = ['secret_text']

  const form = new FormData()
  form.append('metadata', JSON.stringify(metadata))
  form.append('llll-worker.mjs', new Blob([worker], { type: 'application/javascript+module' }), 'llll-worker.mjs')
  return cloudflareApi<unknown>(
    accessToken,
    `/accounts/${accountId}/workers/scripts/${request.workerName}?excludeScript=true&bindings_inherit=strict`,
    { method: 'PUT', body: form },
  )
}

/** Bindings of the retired Installation Control Credential. */
export const CONTROL_BINDING_NAMES = ['LLLL_CONTROL_ID', 'LLLL_CONTROL_ENDPOINT', 'LLLL_CONTROL_TOKEN']

export function updateWorkerBindings(
  current: ExistingWorkerBinding[],
  manifest: InstallerReleaseManifest,
  admin: WorkspaceAdminLink | null = null,
  workerName = '',
) {
  const durable = new Map(manifest.durableObjects.map(item => [item.binding, item]))
  const replaced = new Set([
    'ASSETS',
    'LLLL_VERSION',
    ...durable.keys(),
    // An update through an Admin (re)links the workspace to it and drops the control credential.
    ...(admin ? ['LLLL_ADMIN', ...CONTROL_BINDING_NAMES] : []),
  ])
  const bindings: Array<Record<string, unknown>> = current
    .filter(binding => binding.name && !replaced.has(binding.name))
    .map(binding => ({ type: 'inherit', name: binding.name }))
  const currentNames = new Set(current.map(binding => binding.name))
  bindings.push(
    { type: 'assets', name: 'ASSETS' },
    { type: 'plain_text', name: 'LLLL_VERSION', text: manifest.version },
    ...manifest.durableObjects.map(item => currentNames.has(item.binding)
      ? { type: 'inherit', name: item.binding }
      : { type: 'durable_object_namespace', name: item.binding, class_name: item.className }),
  )
  if (admin) bindings.push(workspaceAdminBinding(workerName, admin))
  return bindings
}

export async function deployL4Update(
  accessToken: string,
  accountId: string,
  workerName: string,
  release: { manifest: InstallerReleaseManifest, worker: ArrayBuffer, assets: InstallerAssetsPayload },
  requestedAdmin: WorkspaceAdminLink | null = null,
) {
  // A release that predates the Admin keeps its Installation Control Credential.
  const admin = requestedAdmin && release.manifest.capabilities?.includes(ADMIN_CAPABILITY) ? requestedAdmin : null
  const client = cloudflareClient(accessToken)
  const account = await client.accounts.get({ account_id: accountId })
  if (account.id !== accountId) throw createError({ statusCode: 403, statusMessage: 'Cloudflare account is unavailable' })
  const existing = await inspectWorker(client, accountId, workerName)
  if (!existing.exists || !existing.bindings || !existing.databaseId || !existing.appHostname) {
    throw createError({ statusCode: 409, statusMessage: 'Existing L4 installation is incomplete' })
  }

  const appliedMigrations = await applyD1Migrations(accessToken, accountId, existing.databaseId, release.assets)
  const assetsJwt = await uploadAssets(accessToken, accountId, workerName, release.assets)
  const metadata: Record<string, unknown> = {
    main_module: 'llll-worker.mjs',
    compatibility_date: release.manifest.compatibilityDate,
    compatibility_flags: release.manifest.compatibilityFlags,
    bindings: updateWorkerBindings(existing.bindings, release.manifest, admin, workerName),
    assets: { jwt: assetsJwt, config: { html_handling: 'none' } },
    observability: workerObservability,
    annotations: {
      'workers/message': `L4 ${release.manifest.version} via installer update`,
      'workers/tag': `llll-${release.manifest.version}`,
    },
  }
  const migrations = durableObjectMigrations(release.manifest, existing)
  if (migrations) metadata.migrations = migrations
  const form = new FormData()
  form.append('metadata', JSON.stringify(metadata))
  form.append('llll-worker.mjs', new Blob([release.worker], { type: 'application/javascript+module' }), 'llll-worker.mjs')
  await cloudflareApi(
    accessToken,
    `/accounts/${accountId}/workers/scripts/${workerName}?excludeScript=true&bindings_inherit=strict`,
    { method: 'PUT', body: form },
  )
  await verifyDeployment(`https://${existing.appHostname}`, release.manifest.version, true)
  return {
    url: `https://${existing.appHostname}`,
    version: release.manifest.version,
    updated: true,
    appliedMigrations,
    verified: true,
    linkedToAdmin: Boolean(admin),
  }
}

export type DeploymentHealthVerificationOptions = {
  attempts?: number
  delayMs?: number
  fetch?: (input: string, init: RequestInit) => Promise<Response>
  wait?: (delayMs: number) => Promise<void>
}

export async function verifyDeployment(
  origin: string,
  version: string,
  expectReady: boolean,
  report?: DeployProgressReporter,
  options: DeploymentHealthVerificationOptions = {},
) {
  const attempts = options.attempts ?? 30
  const delayMs = options.delayMs ?? 3_000
  const fetchHealth = options.fetch ?? fetch
  const wait = options.wait ?? (duration => new Promise(resolve => setTimeout(resolve, duration)))
  let lastStatus = 0
  let lastFailure = ''
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await report?.({
      type: 'progress',
      step: 'verify',
      state: 'active',
      detail: `Attempt ${attempt + 1} of ${attempts}`,
    })
    if (attempt) await wait(delayMs)
    try {
      const response = await fetchHealth(`${origin}/api/setup/health`, {
        headers: { Accept: 'application/json' },
        redirect: 'manual',
        cache: 'no-store',
      })
      lastStatus = response.status
      if (!response.ok) {
        lastFailure = `HTTP ${response.status}`
        continue
      }
      const health = await response.json() as DeploymentHealth
      if (
        health.version === version
        && health.ok
        && health.migrated
        && (!expectReady || health.ready)
      ) return true
      lastFailure = `health response was not ready for L4 ${version}`
    }
    catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error)
    }
  }
  throw createError({
    statusCode: 502,
    statusMessage: `L4 ${version} was deployed, but workspace health verification did not complete${lastFailure ? `: ${lastFailure}` : lastStatus ? ` (HTTP ${lastStatus})` : ''}`,
  })
}

export async function deployL4(
  client: Cloudflare,
  accessToken: string,
  request: DeployRequest,
  release: { manifest: InstallerReleaseManifest, worker: ArrayBuffer, assets: InstallerAssetsPayload },
  report?: DeployProgressReporter,
  control?: InstallationControl,
  admin: WorkspaceAdminLink | null = null,
) {
  const progress = async (step: DeployProgressStep, state: 'active' | 'complete', detail?: string) => {
    await report?.({ type: 'progress', step, state, detail })
  }

  await progress('installation', 'active')
  if (request.mailEnabled && !release.manifest.capabilities?.includes('primary-workspace-mail-v1')) {
    throw createError({ statusCode: 409, statusMessage: `L4 ${release.manifest.version} does not support primary workspace mail` })
  }
  if (admin && !release.manifest.capabilities?.includes(ADMIN_CAPABILITY)) {
    throw createError({ statusCode: 409, statusMessage: `L4 ${release.manifest.version} cannot be managed by a L4 Admin` })
  }
  if (request.filesEnabled === false && !release.manifest.capabilities?.includes('optional-r2')) {
    throw createError({ statusCode: 409, statusMessage: 'Update to a L4 release supporting optional R2 before installing without files' })
  }
  const existing = await inspectWorker(client, request.accountId, request.workerName)
  const existingPrimary = await primaryWorker(client, request.accountId)
  const primary = existing.exists ? existing.primary === true : existingPrimary === null
  if (request.mailEnabled && !primary) {
    throw createError({
      statusCode: 409,
      statusMessage: `Mail is owned by primary L4 Worker ${existingPrimary}. Multi-workspace mail routing is not enabled in this base release.`,
    })
  }
  if (existing.exists && existing.authMode !== request.authMode) {
    throw createError({ statusCode: 409, statusMessage: 'Changing authentication mode on an existing installation requires a manual migration.' })
  }
  const requestedHostname = request.customDomainEnabled
    ? `${request.appSubdomain}.${request.zoneName}`
    : existing.appHostname || await ensureWorkersHostname(client, request.accountId, request.workerName)
  const origin = `https://${requestedHostname}`
  const previousHealth = existing.exists && request.authMode !== 'access'
    ? await readDeploymentHealth(origin)
    : null
  const provisionInfrastructure = requiresInitialInfrastructureProvisioning(existing.exists)
  const provisionDomain = request.customDomainEnabled && !existing.customDomainEnabled
  const provisionMail = request.mailEnabled && !existing.mailZoneId
  if (provisionInfrastructure || provisionDomain || provisionMail) await assertDomainAvailable(accessToken, request)
  const requestedMailDomain = mailDomain(request)
  if (existing.appHostname && existing.appHostname !== requestedHostname && !provisionDomain) {
    throw createError({
      statusCode: 409,
      statusMessage: `This L4 installation already owns ${existing.appHostname}. Domain moves require removing the old Cloudflare route first.`,
    })
  }
  if (existing.exists && Boolean(existing.mailZoneId) && !request.mailEnabled) {
    throw createError({
      statusCode: 409,
      statusMessage: 'Disconnecting workspace email requires a manual migration.',
    })
  }
  if (request.mailEnabled && existing.mailZoneId && (
    existing.mailZoneId !== request.zoneId
    || existing.mailDomain !== requestedMailDomain
  )) {
    throw createError({
      statusCode: 409,
      statusMessage: `This L4 installation already owns ${existing.mailDomain} at ${existing.appHostname}. Domain moves require removing the old Cloudflare routes first.`,
    })
  }
  await progress('installation', 'complete', existing.exists ? 'Existing installation found' : requestedHostname)
  if (!existing.exists) {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(request.adminEmail)) {
      throw createError({ statusCode: 400, statusMessage: 'Enter a valid owner email' })
    }
  }
  const ownerSetupToken = existing.exists || request.authMode === 'access' ? null : randomBase64Url(32)
  const telemetry = {
    installationId: existing.telemetryId || crypto.randomUUID(),
    token: randomBase64Url(32),
  }
  await progress('storage', 'active')
  const { databaseId, bucketName, kvId } = await provisionWorkspaceStorage(client, request, existing)
  await progress('storage', 'complete', bucketName ? 'D1, R2, and KV ready' : 'D1 and KV ready; files and backups disabled')

  await progress('database', 'active')
  const appliedMigrations = await applyD1Migrations(accessToken, request.accountId, databaseId, release.assets)
  await progress('database', 'complete', appliedMigrations.length ? `${appliedMigrations.length} applied` : 'Up to date')

  await progress('assets', 'active')
  const bootstrapRequired = !existing.exists && (request.mailEnabled || (request.authMode === 'access' && !request.customDomainEnabled))
  const accessWorkerId = bootstrapRequired
    ? await ensureBootstrapWorkerTarget(accessToken, request.accountId, request.workerName, release.manifest.compatibilityDate)
    : undefined
  const assetsJwt = await uploadAssets(accessToken, request.accountId, request.workerName, release.assets)
  await progress('assets', 'complete')
  await progress('access', 'active')
  const access = request.authMode === 'access'
    ? existing.exists
      ? {
          issuer: existing.accessIssuer || '',
          audience: existing.accessAudience || '',
          applicationId: existing.accessApplicationId || '',
          healthApplicationId: existing.accessHealthApplicationId || '',
          deletionApplicationId: existing.accessDeletionApplicationId || '',
        }
      : await ensureCloudflareAccess(client, request, requestedHostname, accessWorkerId)
    : null
  if (access && Object.values(access).some(value => !value)) {
    throw createError({ statusCode: 409, statusMessage: 'Existing Cloudflare Access bindings are incomplete' })
  }
  await progress('access', 'complete', request.authMode === 'access' ? 'Email code sign-in ready' : 'Using L4 accounts')

  await progress('worker', 'active')
  const primaryMail = provisionMail
    ? await ensurePrimaryMail(
        client,
        accessToken,
        request,
      )
    : null
  await uploadWorker(accessToken, request.accountId, request, release.manifest, release.worker, {
    databaseId,
    bucketName,
    kvId,
    assetsJwt,
    origin,
  }, existing, ownerSetupToken, telemetry, access, primary, admin, control)
  await progress('worker', 'complete', `L4 ${release.manifest.version}`)

  await progress('domain', 'active')
  await client.workers.scripts.subdomain.create(request.workerName, {
    account_id: request.accountId,
    enabled: !request.customDomainEnabled,
    previews_enabled: false,
  })
  if (request.customDomainEnabled && (provisionInfrastructure || provisionDomain)) await attachAppDomain(accessToken, request)
  await progress('domain', 'complete', requestedHostname)

  await progress('mail', 'active')
  if (provisionMail) {
    await Promise.all([
      ensureEmailRouting(accessToken, request),
      ensureEmailSending(accessToken, request),
    ])
    await attachMailCatchAll(accessToken, request, primaryMail!.name)
  }
  let mailDetail = 'Skipped'
  if (request.mailEnabled) mailDetail = provisionMail ? mailDomain(request) : 'Existing routes preserved'
  await progress('mail', 'complete', mailDetail)

  await progress('schedule', 'active')
  await client.workers.scripts.schedules.update(request.workerName, {
    account_id: request.accountId,
    body: [{ cron: '17 4 * * 1' }],
  })
  await progress('schedule', 'complete')

  await progress('verify', 'active')
  await verifyDeployment(
    origin,
    release.manifest.version,
    requiresReadyVerification(existing.exists, request.authMode, previousHealth),
    report,
  )
  await progress('verify', 'complete', 'Workspace health verified')
  return {
    url: origin,
    setupUrl: ownerSetupToken ? `${origin}/setup#claim=${encodeURIComponent(ownerSetupToken)}` : undefined,
    version: release.manifest.version,
    updated: existing.exists,
    appliedMigrations,
    verified: true,
    telemetry,
  }
}
