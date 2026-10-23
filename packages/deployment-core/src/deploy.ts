import type Cloudflare from 'cloudflare'
import type { DeployProgressReporter, DeployProgressStep, DeployRequest, InstallerAssetsPayload, InstallerReleaseManifest } from './types.js'
import { cloudflareApi, cloudflareClient, cloudflareRetryDelay } from './cloudflare-client.js'
import { createError, InstallerError } from './errors.js'
import { durableObjectMigrations } from './migrations.js'
import { randomBase64Url } from './random.js'
import { ensureCloudflareAccess, ensureWorkersHostname } from './access.js'

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
  version?: string
  mailZoneId?: string
  mailDomain?: string
  appHostname?: string
  publicOrigin?: string
  customDomainEnabled?: boolean
  databaseId?: string
  bucketName?: string
  backupBucketName?: string
  kvId?: string
  authMode?: 'access' | 'builtin'
  accessIssuer?: string
  accessAudience?: string
  accessApplicationId?: string
  accessHealthApplicationId?: string
  lifecycleBindingNames?: string[]
  bindings?: ExistingWorkerBinding[]
  tags?: string[]
  annotations?: { 'workers/tag'?: string } | null
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

export const installerMarker = 'llll.gg/server-v1'
const bootstrapMarker = 'llll.gg/bootstrap/server-v1'
export const serverTag = 'llll-server'
const bootstrapTag = 'llll-server-bootstrap'

/** Variables owned by the installer that a minimal Server env must never keep. */
const legacyEnvBindings = new Set([
  'ADMIN_EMAIL',
  'AGENT_MODEL',
  'APP_NAME',
  'APP_SUBTITLE',
  'APP_TITLE',
  'AUTH_REGISTRATION_MODE',
  'BACKUP_BUCKET_NAME',
  'LLLL_ACCOUNT_ID',
  'LLLL_APP_HOSTNAME',
  'LLLL_APP_SUBDOMAIN',
  'LLLL_APP_ZONE_ID',
  'LLLL_APP_ZONE_NAME',
  'LLLL_CUSTOM_DOMAIN',
  'LLLL_EMAIL_DOMAINS',
  'LLLL_SERVER_MARKER',
  'LLLL_VERSION',
  'LLLL_WORKER_NAME',
  'LLLL_ZONE_ID',
  'LLLL_ZONE_NAME',
  'MAIL_APP_HOSTNAME',
  'MAIL_DEFAULT_LOCAL_PART',
  'SETUP_TOKEN',
])

/** Legacy env the Worker copies into D1 before the installer removes it. */
const runtimeMigratedBindings = new Set([
  'ADMIN_EMAIL',
  'APP_NAME',
  'AUTH_REGISTRATION_MODE',
  'LLLL_EMAIL_DOMAINS',
  'MAIL_APP_HOSTNAME',
  'MAIL_DEFAULT_LOCAL_PART',
  'SETUP_TOKEN',
])

/** Domain and mail routes already belong to a discovered server and are not part of a version upgrade. */
export function requiresInitialInfrastructureProvisioning(existing: boolean): boolean {
  return !existing
}

function mailDomain(request: DeployRequest) {
  return `${request.mailSubdomain}.${request.zoneName}`
}

export function isL4Worker(bindings: ExistingWorkerBinding[], tags?: string[] | null) {
  if (tags?.includes(serverTag)) return true
  const marker = bindings.find(binding => binding.name === 'LLLL_SERVER_MARKER')
  return marker?.type === 'plain_text' && marker.text === installerMarker
}

async function inspectWorker(client: Cloudflare, accountId: string, workerName: string): Promise<ExistingWorker> {
  for await (const worker of client.workers.scripts.list({ account_id: accountId })) {
    if (worker.id !== workerName) continue
    const settings = await client.workers.scripts.scriptAndVersionSettings.get(workerName, { account_id: accountId })
    const bindings = settings.bindings as ExistingWorkerBinding[] || []
    const tags = settings.tags || []
    const annotations = settings.annotations || {}
    const marker = bindings.find(binding => binding.name === 'LLLL_SERVER_MARKER')
    if (tags.includes(bootstrapTag) || (marker?.type === 'plain_text' && marker.text === bootstrapMarker)) return { exists: false }
    if (!isL4Worker(bindings, tags)) {
      throw createError({ statusCode: 409, statusMessage: `A non-L4 Worker named ${workerName} already exists` })
    }
    const text = (name: string) => bindings.find(binding => binding.name === name && binding.type === 'plain_text')?.text
    const publicOrigin = text('PUBLIC_ORIGIN')
    let appHostname = text('LLLL_APP_HOSTNAME') || text('MAIL_APP_HOSTNAME')
    if (!appHostname && publicOrigin) {
      try { appHostname = new URL(publicOrigin).hostname } catch { /* A malformed legacy env is handled below. */ }
    }
    const lifecycleBindingNames = [
      'LLLL_EMAIL_DOMAINS',
      'LLLL_APP_ZONE_ID',
      'LLLL_APP_ZONE_NAME',
    ].filter(name => bindings.some(binding => binding.name === name))
    return {
      exists: true,
      migrationTag: worker.migration_tag,
      version: annotations['workers/tag']?.replace(/^llll-/u, '') || text('LLLL_VERSION'),
      mailZoneId: JSON.parse(text('LLLL_EMAIL_DOMAINS') || '[]')[0]?.zoneId,
      mailDomain: JSON.parse(text('LLLL_EMAIL_DOMAINS') || '[]')[0]?.domain,
      appHostname,
      publicOrigin,
      customDomainEnabled: text('LLLL_CUSTOM_DOMAIN') === 'true',
      databaseId: bindings.find(binding => binding.name === 'DB' && binding.type === 'd1')?.database_id,
      bucketName: bindings.find(binding => binding.name === 'FILES' && binding.type === 'r2_bucket')?.bucket_name,
      backupBucketName: bindings.find(binding => binding.name === 'BACKUPS' && binding.type === 'r2_bucket')?.bucket_name,
      kvId: bindings.find(binding => binding.name === 'TICKETS' && binding.type === 'kv_namespace')?.namespace_id,
      authMode: text('AUTH_MODE') === 'access' ? 'access' : 'builtin',
      accessIssuer: text('CF_ACCESS_ISS'),
      accessAudience: text('CF_ACCESS_AUD'),
      accessApplicationId: text('CF_ACCESS_APP_ID'),
      accessHealthApplicationId: text('CF_ACCESS_HEALTH_APP_ID'),
      lifecycleBindingNames,
      bindings,
      tags,
      annotations,
    }
  }
  return { exists: false }
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

export async function provisionServerStorage(client: Cloudflare, request: Pick<DeployRequest, 'accountId' | 'serverId' | 'workerName' | 'filesEnabled'>, existing: Pick<ExistingWorker, 'exists' | 'databaseId' | 'bucketName' | 'kvId'>) {
  const prefix = request.serverId ? `llll-${request.serverId}` : request.workerName
  const [databaseId, bucketName, kvId] = existing.exists
    ? [existing.databaseId, existing.bucketName, existing.kvId]
    : await Promise.all([
        ensureD1(client, request.accountId, `${prefix}-db`),
        request.filesEnabled !== false ? ensureR2(client, request.accountId, `${prefix}-files`) : undefined,
        ensureKv(client, request.accountId, `${prefix}-tickets`),
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

async function attachMailCatchAll(accessToken: string, request: DeployRequest, workerName: string) {
  await cloudflareApi(accessToken, `/zones/${request.zoneId}/email/routing/rules/catch_all`, {
    method: 'PUT',
    body: JSON.stringify({
      name: `L4 Server mail for ${request.zoneName}`,
      enabled: true,
      matchers: [{ type: 'all' }],
      actions: [{ type: 'worker', value: [workerName] }],
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

async function d1Query(
  accessToken: string,
  accountId: string,
  databaseId: string,
  sql: string,
  params: Array<string | number | null> = [],
) {
  const results = await cloudflareApi<Array<{ success?: boolean }>>(
    accessToken,
    `/accounts/${accountId}/d1/database/${databaseId}/query`,
    { method: 'POST', body: JSON.stringify({ sql, params }) },
  )
  if (results.some(statement => statement.success === false)) {
    throw createError({ statusCode: 502, statusMessage: 'L4 database setup did not complete' })
  }
  return results
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * Establish the one UUID before the Worker handles a request. The same value
 * names the Worker and its D1/R2/KV resources, and is the permanent Server ID.
 */
async function seedNewServer(
  accessToken: string,
  accountId: string,
  databaseId: string,
  request: DeployRequest,
  origin: string,
  setupToken: string | null,
) {
  const now = new Date().toISOString()
  await d1Query(accessToken, accountId, databaseId,
    'INSERT INTO server_identity (singleton, id) VALUES (1, ?) ON CONFLICT(singleton) DO NOTHING',
    [request.serverId])
  if (request.filesEnabled === false) await d1Query(accessToken, accountId, databaseId,
    "INSERT INTO server_settings(key,value,updated_at) VALUES('storage.backend','kv',?) ON CONFLICT(key) DO NOTHING", [now])
  const backupBucketName = serverBackupBucketName(request)
  if (backupBucketName) {
    await d1Query(accessToken, accountId, databaseId,
      `INSERT INTO server_settings (key, value, updated_at) VALUES ('backup_bucket', ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [backupBucketName, now])
  }
  await d1Query(accessToken, accountId, databaseId,
    'INSERT INTO auth_settings (id, registration_mode) VALUES (1, ?) ON CONFLICT(id) DO NOTHING',
    [request.registrationMode])
  if (request.mailEnabled) {
    const domains = JSON.stringify([{
      id: crypto.randomUUID(),
      domain: mailDomain(request),
      zoneId: request.zoneId,
    }])
    await d1Query(accessToken, accountId, databaseId,
      `INSERT INTO server_settings (key, value, updated_at) VALUES ('mail_domains', ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [domains, now])
    await d1Query(accessToken, accountId, databaseId,
      `INSERT INTO server_settings (key, value, updated_at) VALUES ('mail_app_hostname', ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [new URL(origin).hostname, now])
    await d1Query(accessToken, accountId, databaseId,
      `INSERT INTO server_settings (key, value, updated_at) VALUES ('mail_default_local_part', ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [request.mailLocalPart, now])
  }
  if (setupToken) {
    await d1Query(accessToken, accountId, databaseId,
      `INSERT INTO server_setup (singleton, email, token_hash, server_name, created_at, updated_at)
       VALUES (1, ?, ?, ?, ?, ?)
       ON CONFLICT(singleton) DO UPDATE SET email = excluded.email, token_hash = excluded.token_hash,
         server_name = excluded.server_name, updated_at = excluded.updated_at`,
      [request.adminEmail, await sha256Hex(setupToken), request.appName, now, now])
  }
}

async function rememberWorkerName(accessToken: string, accountId: string, databaseId: string, workerName: string) {
  await d1Query(accessToken, accountId, databaseId,
    `INSERT INTO server_settings (key, value, updated_at) VALUES ('worker_name', ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [workerName, new Date().toISOString()])
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
    bindings: [],
    tags: [bootstrapTag],
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
  access: { issuer: string, audience: string, applicationId: string, healthApplicationId: string } | null,
) {
  const backupBucketName = serverBackupBucketName(request, existing)
  if (backupBucketName) {
    if (backupBucketName === resources.bucketName) throw createError({ statusCode: 400, statusMessage: 'Backup bucket must be separate from live files' })
    await ensureR2(cloudflareClient(accessToken), accountId, backupBucketName)
  }
  const bindings: Array<Record<string, unknown>> = existing.exists && existing.bindings?.length
    ? updateWorkerBindings(existing.bindings, manifest, {
        accountId,
        publicOrigin: resources.origin,
        authMode: existing.authMode,
      })
    : [
        { type: 'd1', name: 'DB', database_id: resources.databaseId },
        { type: 'kv_namespace', name: 'TICKETS', namespace_id: resources.kvId },
        { type: 'ai', name: 'AI' },
        { type: 'browser', name: 'BROWSER' },
        { type: 'assets', name: 'ASSETS' },
        { type: 'plain_text', name: 'PUBLIC_ORIGIN', text: resources.origin },
        { type: 'plain_text', name: 'AUTH_MODE', text: request.authMode },
        { type: 'plain_text', name: 'ACCOUNT_ID', text: accountId },
        ...manifest.durableObjects.map(item => ({ type: 'durable_object_namespace', name: item.binding, class_name: item.className })),
      ]
  if (backupBucketName) bindings.push({ type: 'r2_bucket', name: 'BACKUPS', bucket_name: backupBucketName })
  if (resources.bucketName) bindings.push({ type: 'r2_bucket', name: 'FILES', bucket_name: resources.bucketName })
  if (access) {
    bindings.push(
      { type: 'plain_text', name: 'CF_ACCESS_ISS', text: access.issuer },
      { type: 'plain_text', name: 'CF_ACCESS_AUD', text: access.audience },
      { type: 'plain_text', name: 'CF_ACCESS_APP_ID', text: access.applicationId },
      { type: 'plain_text', name: 'CF_ACCESS_HEALTH_APP_ID', text: access.healthApplicationId },
    )
  }
  if (request.mailEnabled) bindings.push({ type: 'send_email', name: 'MAIL_EMAIL' })
  if (!existing.exists) bindings.push({ type: 'secret_text', name: 'AUTH_SECRET', text: randomBase64Url(48) })

  const definedBindings = new Set(bindings.map(binding => String(binding.name)))
  for (const name of existing.lifecycleBindingNames || []) {
    if (!definedBindings.has(name) && !manifest.removedBindings?.includes(name)) bindings.push({ type: 'inherit', name })
  }

  const migrations = durableObjectMigrations(manifest, existing)
  const metadata: Record<string, unknown> = {
    main_module: 'llll-worker.mjs',
    compatibility_date: manifest.compatibilityDate,
    // Every Server validates socket sessions against its own local database.
    compatibility_flags: [...new Set([...manifest.compatibilityFlags, 'global_fetch_strictly_public'])],
    bindings,
    assets: { jwt: resources.assetsJwt, config: { html_handling: 'none' } },
    observability: workerObservability,
    tags: [serverTag],
    annotations: {
      'workers/message': `L4 ${manifest.version} via installer`,
      'workers/tag': `llll-${manifest.version}`,
    },
  }
  if (migrations) metadata.migrations = migrations

  const form = new FormData()
  form.append('metadata', JSON.stringify(metadata))
  form.append('llll-worker.mjs', new Blob([worker], { type: 'application/javascript+module' }), 'llll-worker.mjs')
  return cloudflareApi<unknown>(
    accessToken,
    `/accounts/${accountId}/workers/scripts/${request.workerName}?excludeScript=true&bindings_inherit=strict`,
    { method: 'PUT', body: form },
  )
}

export function serverBackupBucketName(
  request: Pick<DeployRequest, 'backupBucketName' | 'serverId' | 'filesEnabled'>,
  existing?: Pick<ExistingWorker, 'exists' | 'backupBucketName'>,
) {
  return request.backupBucketName
    || (existing?.exists ? existing.backupBucketName : request.filesEnabled !== false && request.serverId ? `llll-${request.serverId}-backups` : undefined)
}

export function updateWorkerBindings(
  current: ExistingWorkerBinding[],
  manifest: InstallerReleaseManifest,
  options: { minimal?: boolean, accountId?: string, publicOrigin?: string, authMode?: 'access' | 'builtin' } = {},
) {
  const replaced = new Set([
    'ASSETS',
    ...manifest.removedBindings || [],
    'LLLL_VERSION',
    'LLLL_SERVER_MARKER',
    ...(options.minimal ? legacyEnvBindings : []),
    ...manifest.durableObjects.map(item => item.binding),
  ])
  const bindings: Array<Record<string, unknown>> = current
    .filter(binding => binding.name && !replaced.has(binding.name))
    .map(binding => ({ type: 'inherit', name: binding.name }))
  const currentNames = new Set(current.map(binding => binding.name))
  if (!currentNames.has('PUBLIC_ORIGIN') && options.publicOrigin) {
    bindings.push({ type: 'plain_text', name: 'PUBLIC_ORIGIN', text: options.publicOrigin })
  }
  if (!currentNames.has('AUTH_MODE') && options.authMode) {
    bindings.push({ type: 'plain_text', name: 'AUTH_MODE', text: options.authMode })
  }
  bindings.push(
    { type: 'assets', name: 'ASSETS' },
    ...(options.accountId ? [{ type: 'plain_text', name: 'ACCOUNT_ID', text: options.accountId }] : []),
    ...manifest.durableObjects.map(item => currentNames.has(item.binding)
      ? { type: 'inherit', name: item.binding }
      : { type: 'durable_object_namespace', name: item.binding, class_name: item.className }),
  )
  return bindings
}

/** Copy non-secret legacy settings that the new Worker no longer reads from env. */
async function migrateLegacyBindings(
  accessToken: string,
  accountId: string,
  databaseId: string,
  workerName: string,
  bindings: ExistingWorkerBinding[],
) {
  const text = (name: string) => bindings.find(binding => binding.name === name && binding.type === 'plain_text')?.text?.trim() || ''
  const settings: Array<[string, string]> = [['worker_name', workerName]]
  const backupBucket = text('BACKUP_BUCKET_NAME') || bindings.find(binding => binding.name === 'BACKUPS' && binding.type === 'r2_bucket')?.bucket_name || ''
  if (backupBucket) settings.push(['backup_bucket', backupBucket])
  const appName = text('APP_NAME')
  if (appName) settings.push(['initial_name', appName])
  const mailDomains = text('LLLL_EMAIL_DOMAINS')
  const mailAppHostname = text('MAIL_APP_HOSTNAME') || text('LLLL_APP_HOSTNAME')
  const mailLocalPart = text('MAIL_DEFAULT_LOCAL_PART')
  if (mailDomains) settings.push(['mail_domains', mailDomains])
  if (mailAppHostname) settings.push(['mail_app_hostname', mailAppHostname])
  if (mailLocalPart) settings.push(['mail_default_local_part', mailLocalPart])
  const placeholders = settings.map(() => 'SELECT ? AS key, ? AS value, ? AS updated_at').join(' UNION ALL ')
  const now = new Date().toISOString()
  await d1Query(accessToken, accountId, databaseId,
    `INSERT INTO server_settings (key, value, updated_at) ${placeholders}
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    settings.flatMap(([key, value]) => [key, value, now]))
  const registrationMode = text('AUTH_REGISTRATION_MODE')
  if (registrationMode === 'open' || registrationMode === 'invite_only') {
    await d1Query(accessToken, accountId, databaseId,
      'INSERT INTO auth_settings (id, registration_mode) VALUES (1, ?) ON CONFLICT(id) DO NOTHING',
      [registrationMode])
  }
}

export type InstallVerifyOptions = {
  /** Disable only when the caller separately verifies the deployed public endpoint. */
  verify?: boolean
  /** Keep the caller's one-time owner claim instead of generating a new one. */
  setupToken?: string
}

export async function deployL4Update(
  accessToken: string,
  accountId: string,
  workerName: string,
  release: { manifest: InstallerReleaseManifest, worker: ArrayBuffer, assets: InstallerAssetsPayload },
  options: InstallVerifyOptions = {},
) {
  const client = cloudflareClient(accessToken)
  const account = await client.accounts.get({ account_id: accountId })
  if (account.id !== accountId) throw createError({ statusCode: 403, statusMessage: 'Cloudflare account is unavailable' })
  const existing = await inspectWorker(client, accountId, workerName)
  if (!existing.exists || !existing.bindings || !existing.databaseId || !existing.appHostname) {
    throw createError({ statusCode: 409, statusMessage: 'Existing L4 server is incomplete' })
  }

  const appliedMigrations = await applyD1Migrations(accessToken, accountId, existing.databaseId, release.assets)
  await migrateLegacyBindings(accessToken, accountId, existing.databaseId, workerName, existing.bindings)
  const assetsJwt = await uploadAssets(accessToken, accountId, workerName, release.assets)
  const origin = existing.publicOrigin || `https://${existing.appHostname}`
  const metadata: Record<string, unknown> = {
    main_module: 'llll-worker.mjs',
    compatibility_date: release.manifest.compatibilityDate,
    compatibility_flags: [...new Set([...release.manifest.compatibilityFlags, 'global_fetch_strictly_public'])],
    bindings: updateWorkerBindings(existing.bindings, release.manifest, {
      accountId,
      publicOrigin: origin,
      authMode: existing.authMode,
    }),
    assets: { jwt: assetsJwt, config: { html_handling: 'none' } },
    observability: workerObservability,
    tags: [serverTag],
    annotations: {
      'workers/message': `L4 ${release.manifest.version} via installer update`,
      'workers/tag': `llll-${release.manifest.version}`,
    },
  }
  const version = (worker: ExistingWorker) => worker.annotations?.['workers/tag']?.replace(/^llll-/u, '')
    || worker.bindings?.find(binding => binding.name === 'LLLL_VERSION')?.text
  let current = existing
  for (let attempt = 0; ; attempt++) {
    metadata.bindings = updateWorkerBindings(current.bindings!, release.manifest, {
      accountId,
      publicOrigin: origin,
      authMode: existing.authMode,
    })
    const migrations = durableObjectMigrations(release.manifest, current)
    if (migrations) metadata.migrations = migrations
    else delete metadata.migrations
    const form = new FormData()
    form.append('metadata', JSON.stringify(metadata))
    form.append('llll-worker.mjs', new Blob([release.worker], { type: 'application/javascript+module' }), 'llll-worker.mjs')
    try {
      await cloudflareApi(
        accessToken,
        `/accounts/${accountId}/workers/scripts/${workerName}?excludeScript=true&bindings_inherit=strict`,
        { method: 'PUT', body: form, signal: AbortSignal.timeout(120_000) },
      )
      break
    } catch (error) {
      const delay = cloudflareRetryDelay(error, attempt)
      if (delay === null) throw error
      console.warn(JSON.stringify({ step: 'worker-upload-reconcile', failedAttempt: attempt + 1, maxAttempts: 4, statusCode: error instanceof InstallerError ? error.statusCode : undefined, delayMs: delay }))
      await new Promise(resolve => setTimeout(resolve, delay))
      current = await inspectWorker(client, accountId, workerName)
      if (!current.exists || !current.bindings || current.databaseId !== existing.databaseId
        || current.appHostname !== existing.appHostname || current.bucketName !== existing.bucketName || current.kvId !== existing.kvId) {
        throw createError({ statusCode: 409, statusMessage: 'Server resources changed during the update; refusing to retry' })
      }
      // A 5xx response can arrive after Cloudflare accepted the upload. Keep
      // verification below, but never replay its Durable Object migrations.
      if (version(current) === release.manifest.version) break
      if (version(current) !== version(existing)) {
        throw createError({ statusCode: 409, statusMessage: 'Installed Server version changed during the update; refusing to retry' })
      }
      if (attempt === 3) throw error
    }
  }
  if (options.verify !== false) {
    await verifyDeployment(origin, release.manifest.version, true)
    // The new Worker copied legacy secret settings into D1 during its first
    // health request. A second metadata-only upload can now remove the old
    // env without ever exposing those values to the installer.
    const runtimeMigration = existing.bindings.some(binding => binding.name && runtimeMigratedBindings.has(binding.name))
    if (runtimeMigration) {
      metadata.bindings = updateWorkerBindings(current.bindings!, release.manifest, {
        minimal: true,
        accountId,
        publicOrigin: origin,
        authMode: existing.authMode,
      })
      delete metadata.migrations
      for (let attempt = 0; ; attempt++) {
        const form = new FormData()
        form.append('metadata', JSON.stringify(metadata))
        form.append('llll-worker.mjs', new Blob([release.worker], { type: 'application/javascript+module' }), 'llll-worker.mjs')
        try {
          await cloudflareApi(
            accessToken,
            `/accounts/${accountId}/workers/scripts/${workerName}?excludeScript=true&bindings_inherit=strict`,
            { method: 'PUT', body: form, signal: AbortSignal.timeout(120_000) },
          )
          break
        } catch (error) {
          const delay = cloudflareRetryDelay(error, attempt)
          if (delay === null) throw error
          if (attempt === 3) throw error
          await new Promise(resolve => setTimeout(resolve, delay))
        }
      }
      await verifyDeployment(origin, release.manifest.version, true)
    }
  }
  return {
    url: origin,
    version: release.manifest.version,
    updated: true,
    appliedMigrations,
    verified: options.verify !== false,
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
    statusMessage: `L4 ${version} was deployed, but server health verification did not complete${lastFailure ? `: ${lastFailure}` : lastStatus ? ` (HTTP ${lastStatus})` : ''}`,
  })
}

export async function deployL4(
  client: Cloudflare,
  accessToken: string,
  request: DeployRequest,
  release: { manifest: InstallerReleaseManifest, worker: ArrayBuffer, assets: InstallerAssetsPayload },
  report?: DeployProgressReporter,
  options: InstallVerifyOptions = {},
) {
  const progress = async (step: DeployProgressStep, state: 'active' | 'complete', detail?: string) => {
    await report?.({ type: 'progress', step, state, detail })
  }

  await progress('server', 'active')
  if (request.mailEnabled && !release.manifest.capabilities?.includes('server-mail-v1')) {
    throw createError({ statusCode: 409, statusMessage: `L4 ${release.manifest.version} does not support Server mail` })
  }
  if (request.filesEnabled === false && !release.manifest.capabilities?.includes('optional-r2')) {
    throw createError({ statusCode: 409, statusMessage: 'Update to a L4 release supporting optional R2 before installing without files' })
  }
  const existing = await inspectWorker(client, request.accountId, request.workerName)
  if (existing.exists && existing.authMode !== request.authMode) {
    throw createError({ statusCode: 409, statusMessage: 'Changing authentication mode on an existing server requires a manual migration.' })
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
      statusMessage: `This L4 server already owns ${existing.appHostname}. Domain moves require removing the old Cloudflare route first.`,
    })
  }
  if (existing.exists && Boolean(existing.mailZoneId) && !request.mailEnabled) {
    throw createError({
      statusCode: 409,
      statusMessage: 'Disconnecting server email requires a manual migration.',
    })
  }
  if (request.mailEnabled && existing.mailZoneId && (
    existing.mailZoneId !== request.zoneId
    || existing.mailDomain !== requestedMailDomain
  )) {
    throw createError({
      statusCode: 409,
      statusMessage: `This L4 server already owns ${existing.mailDomain} at ${existing.appHostname}. Domain moves require removing the old Cloudflare routes first.`,
    })
  }
  await progress('server', 'complete', existing.exists ? 'Existing server found' : requestedHostname)
  if (!existing.exists) {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(request.adminEmail)) {
      throw createError({ statusCode: 400, statusMessage: 'Enter a valid owner email' })
    }
  }
  if (options.setupToken && !/^[A-Za-z0-9_-]{32,256}$/.test(options.setupToken))
    throw createError({ statusCode: 400, statusMessage: 'Owner claim is invalid' })
  const ownerSetupToken = existing.exists || request.authMode === 'access' ? null : options.setupToken || randomBase64Url(32)
  await progress('storage', 'active')
  const { databaseId, bucketName, kvId } = await provisionServerStorage(client, request, existing)
  await progress('storage', 'complete', bucketName ? 'D1, R2, and KV ready' : 'D1 and KV ready; files and backups disabled')

  await progress('database', 'active')
  const appliedMigrations = await applyD1Migrations(accessToken, request.accountId, databaseId, release.assets)
  if (!existing.exists) await seedNewServer(accessToken, request.accountId, databaseId, request, origin, ownerSetupToken)
  else await rememberWorkerName(accessToken, request.accountId, databaseId, request.workerName)
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
        }
      : await ensureCloudflareAccess(client, request, requestedHostname, accessWorkerId)
    : null
  if (access && Object.values(access).some(value => !value)) {
    throw createError({ statusCode: 409, statusMessage: 'Existing Cloudflare Access bindings are incomplete' })
  }
  await progress('access', 'complete', request.authMode === 'access' ? 'Email code sign-in ready' : 'Using local accounts')

  await progress('worker', 'active')
  await uploadWorker(accessToken, request.accountId, request, release.manifest, release.worker, {
    databaseId,
    bucketName,
    kvId,
    assetsJwt,
    origin,
  }, existing, ownerSetupToken, access)
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
    await attachMailCatchAll(accessToken, request, request.workerName)
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

  if (options.verify !== false) {
    await progress('verify', 'active')
    await verifyDeployment(
      origin,
      release.manifest.version,
      requiresReadyVerification(existing.exists, request.authMode, previousHealth),
      report,
    )
    await progress('verify', 'complete', 'Server health verified')
  }
  return {
    url: origin,
    setupUrl: ownerSetupToken ? `${origin}/setup#claim=${encodeURIComponent(ownerSetupToken)}` : undefined,
    version: release.manifest.version,
    updated: existing.exists,
    appliedMigrations,
    verified: options.verify !== false,
  }
}
