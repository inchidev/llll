// A Server on L4 Cloud: the same published release, uploaded by the control plane to its own Workers for Platforms
// dispatch namespace, with its own D1, buckets and KV. Nothing here touches a customer's account, and nothing here
// gives the Server an account token: the Server runs with `LLLL_RUNTIME=cloud` and asks the control plane for nothing.
// See docs/adr/0008-server-per-tenant.md.

import { cloudflareApi } from './cloudflare-client.js'
import { applyD1Migrations, scriptApiPath, seedNewServer, serverTag, uploadAssets, verifyDeployment } from './deploy.js'
import { createError } from './errors.js'
import { durableObjectMigrations } from './migrations.js'
import { randomBase64Url } from './random.js'
import { loadL4Release, releaseManifestUrl } from './release.js'
import type { DeployProgressReporter, DeployProgressStep, InstallerRelease, InstallerReleaseManifest } from './types.js'

export const cloudTag = 'llll-cloud'
/** The path the Server answers to its control plane, with the Server's `CLOUD_SECRET` as a bearer token. */
export const CLOUD_RELAY_PATH = '/.llll/cloud'

export type HostedInstallRequest = {
  accountId: string
  namespace: string
  serverId: string
  /** The Server's name, as its Owner will see it. */
  name: string
  /** `<subdomain>.llll.gg`: the control plane routes it to the script. */
  hostname: string
  targetVersion?: string
}

export type HostedResources = {
  databaseId: string
  filesBucket: string
  backupBucket: string
  kvId: string
}

export type HostedInstallOptions = {
  manifestUrl?: string
  report?: DeployProgressReporter
  verify?: boolean
  /** Reads the release; tests give a fake one. Cloudflare's API always goes through the global fetch. */
  fetch?: typeof fetch
  /** Keep the caller's one-time Owner claim instead of generating a new one. */
  setupToken?: string
  /** Keep the caller's secrets, so that a retried upload does not change them. */
  authSecret?: string
  cloudSecret?: string
  /** Resources made by an earlier attempt, which are reused instead of made again. */
  resources?: Partial<HostedResources>
}

export type HostedInstallResponse = {
  origin: string
  setupUrl: string
  version: string
  scriptName: string
  resources: HostedResources
  authSecret: string
  cloudSecret: string
  appliedMigrations: string[]
  verified: boolean
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u

export function parseHostedInstallRequest(value: unknown): HostedInstallRequest {
  const body = (value && typeof value === 'object' ? value : {}) as Partial<HostedInstallRequest>
  const accountId = String(body.accountId || '').trim()
  const namespace = String(body.namespace || '').trim()
  const serverId = String(body.serverId || '').trim().toLowerCase()
  const name = String(body.name || '').trim()
  const hostname = String(body.hostname || '').trim().toLowerCase()
  const targetVersion = body.targetVersion === undefined ? undefined : String(body.targetVersion).trim()
  if (!/^[0-9a-f]{32}$/u.test(accountId)) throw createError({ statusCode: 400, statusMessage: 'Cloudflare account ID is invalid' })
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/u.test(namespace)) throw createError({ statusCode: 400, statusMessage: 'Dispatch namespace name is invalid' })
  if (!UUID.test(serverId)) throw createError({ statusCode: 400, statusMessage: 'Server ID is invalid' })
  if (!name || name.length > 80) throw createError({ statusCode: 400, statusMessage: 'Server name must be 1–80 characters' })
  if (!HOSTNAME.test(hostname)) throw createError({ statusCode: 400, statusMessage: 'Server hostname is invalid' })
  if (targetVersion !== undefined && !/^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(targetVersion)) throw createError({ statusCode: 400, statusMessage: 'Release version is invalid' })
  return { accountId, namespace, serverId, name, hostname, ...(targetVersion ? { targetVersion } : {}) }
}

export const hostedScriptName = (serverId: string) => `srv-${serverId}`

/** The resources of one hosted Server, named after its UUID so that they are found again and never shared. */
export function hostedResourceNames(serverId: string) {
  const prefix = `llll-srv-${serverId}`
  return { database: `${prefix}-db`, files: `${prefix}-files`, backups: `${prefix}-backups`, tickets: `${prefix}-tickets` }
}

/**
 * The bindings of a hosted Server. No `ACCOUNT_ID`, so the Server never manages infrastructure; no `AI` or `BROWSER`,
 * which the platform would pay for (ADR 0008); `LLLL_RUNTIME=cloud` for what the Server turns off itself.
 */
export function hostedWorkerBindings(
  manifest: Pick<InstallerReleaseManifest, 'durableObjects'>,
  resources: HostedResources,
  origin: string,
  secrets: { authSecret: string; cloudSecret: string },
): Array<Record<string, unknown>> {
  return [
    { type: 'd1', name: 'DB', database_id: resources.databaseId },
    { type: 'kv_namespace', name: 'TICKETS', namespace_id: resources.kvId },
    { type: 'r2_bucket', name: 'FILES', bucket_name: resources.filesBucket },
    { type: 'r2_bucket', name: 'BACKUPS', bucket_name: resources.backupBucket },
    { type: 'assets', name: 'ASSETS' },
    { type: 'plain_text', name: 'PUBLIC_ORIGIN', text: origin },
    { type: 'plain_text', name: 'AUTH_MODE', text: 'builtin' },
    { type: 'plain_text', name: 'LLLL_RUNTIME', text: 'cloud' },
    { type: 'secret_text', name: 'AUTH_SECRET', text: secrets.authSecret },
    { type: 'secret_text', name: 'CLOUD_SECRET', text: secrets.cloudSecret },
    ...manifest.durableObjects.map(item => ({ type: 'durable_object_namespace', name: item.binding, class_name: item.className })),
  ]
}

const notFound = (error: unknown) => Boolean(error && typeof error === 'object' && 'statusCode' in error && (error as { statusCode: number }).statusCode === 404)
const conflict = (error: unknown) => Boolean(error && typeof error === 'object' && 'statusCode' in error && [400, 409].includes((error as { statusCode: number }).statusCode))

// Each resource is made once, by name. A retry after a partial failure finds what the first attempt made.
async function ensureHostedD1(accessToken: string, accountId: string, name: string) {
  try {
    const database = await cloudflareApi<{ uuid?: string }>(accessToken, `/accounts/${accountId}/d1/database`, { method: 'POST', body: JSON.stringify({ name }) })
    if (database.uuid) return database.uuid
  } catch (error) {
    if (!conflict(error)) throw error
  }
  const found = await cloudflareApi<Array<{ uuid?: string; name?: string }>>(accessToken, `/accounts/${accountId}/d1/database?name=${encodeURIComponent(name)}`)
  const uuid = found.find(database => database.name === name)?.uuid
  if (!uuid) throw createError({ statusCode: 502, statusMessage: 'Cloudflare did not return the D1 database ID' })
  return uuid
}

async function ensureHostedR2(accessToken: string, accountId: string, name: string) {
  try {
    await cloudflareApi(accessToken, `/accounts/${accountId}/r2/buckets`, { method: 'POST', body: JSON.stringify({ name }) })
  } catch (error) {
    if (!conflict(error)) throw error
    await cloudflareApi(accessToken, `/accounts/${accountId}/r2/buckets/${name}`)
  }
  return name
}

async function ensureHostedKv(accessToken: string, accountId: string, title: string) {
  const namespace = await cloudflareApi<{ id?: string }>(accessToken, `/accounts/${accountId}/storage/kv/namespaces`, { method: 'POST', body: JSON.stringify({ title }) })
  if (!namespace.id) throw createError({ statusCode: 502, statusMessage: 'Cloudflare did not return the KV namespace ID' })
  return namespace.id
}

export async function provisionHostedStorage(accessToken: string, request: Pick<HostedInstallRequest, 'accountId' | 'serverId'>, known: Partial<HostedResources> = {}): Promise<HostedResources> {
  const names = hostedResourceNames(request.serverId)
  const [databaseId, filesBucket, backupBucket, kvId] = await Promise.all([
    known.databaseId || ensureHostedD1(accessToken, request.accountId, names.database),
    known.filesBucket || ensureHostedR2(accessToken, request.accountId, names.files),
    known.backupBucket || ensureHostedR2(accessToken, request.accountId, names.backups),
    known.kvId || ensureHostedKv(accessToken, request.accountId, names.tickets),
  ])
  return { databaseId, filesBucket, backupBucket, kvId }
}

async function scriptExists(accessToken: string, path: string) {
  try {
    await cloudflareApi(accessToken, `${path}/settings`)
    return true
  } catch (error) {
    if (notFound(error)) return false
    throw error
  }
}

async function uploadHostedWorker(
  accessToken: string,
  request: HostedInstallRequest,
  release: InstallerRelease,
  resources: HostedResources,
  assetsJwt: string,
  origin: string,
  secrets: { authSecret: string; cloudSecret: string },
) {
  const path = scriptApiPath(request.accountId, hostedScriptName(request.serverId), { namespace: request.namespace })
  // A script a failed attempt left behind already holds its Durable Object classes: the same migration must not run twice.
  const exists = await scriptExists(accessToken, path)
  const metadata: Record<string, unknown> = {
    main_module: 'llll-worker.mjs',
    compatibility_date: release.manifest.compatibilityDate,
    compatibility_flags: [...new Set([...release.manifest.compatibilityFlags, 'global_fetch_strictly_public'])],
    bindings: hostedWorkerBindings(release.manifest, resources, origin, secrets),
    assets: { jwt: assetsJwt, config: { html_handling: 'none' } },
    tags: [serverTag, cloudTag],
    annotations: {
      'workers/message': `L4 ${release.manifest.version} via L4 Cloud`,
      'workers/tag': `llll-${release.manifest.version}`,
    },
  }
  if (!exists) metadata.migrations = durableObjectMigrations(release.manifest, { exists: false })
  const form = new FormData()
  form.append('metadata', JSON.stringify(metadata))
  form.append('llll-worker.mjs', new Blob([release.worker], { type: 'application/javascript+module' }), 'llll-worker.mjs')
  await cloudflareApi<unknown>(accessToken, path, { method: 'PUT', body: form })
}

/** Installs a Server on L4 Cloud from a published, checksum-verified release. Every step reports through `options.report`. */
export async function installHostedL4(accessToken: string, value: unknown, options: HostedInstallOptions = {}): Promise<HostedInstallResponse> {
  if (!accessToken.trim()) throw createError({ statusCode: 401, statusMessage: 'Cloudflare API token is missing' })
  const request = parseHostedInstallRequest(value)
  const progress = async (step: DeployProgressStep, state: 'active' | 'complete', detail?: string) => {
    await options.report?.({ type: 'progress', step, state, detail })
  }
  const origin = `https://${request.hostname}`
  if (options.setupToken && !/^[A-Za-z0-9_-]{32,256}$/u.test(options.setupToken)) throw createError({ statusCode: 400, statusMessage: 'Owner claim is invalid' })
  const setupToken = options.setupToken || randomBase64Url(32)
  const secrets = { authSecret: options.authSecret || randomBase64Url(48), cloudSecret: options.cloudSecret || randomBase64Url(32) }

  await progress('release', 'active')
  const release = await loadL4Release(options.manifestUrl || releaseManifestUrl(request.targetVersion), options.fetch)
  if (request.targetVersion && release.manifest.version !== request.targetVersion.replace(/^v/u, '')) {
    throw createError({ statusCode: 502, statusMessage: 'L4 release manifest version does not match the requested version' })
  }
  await progress('release', 'complete', `L4 ${release.manifest.version}`)

  await progress('storage', 'active')
  const resources = await provisionHostedStorage(accessToken, request, options.resources)
  await progress('storage', 'complete', 'D1, R2 and KV ready')

  await progress('database', 'active')
  const appliedMigrations = await applyD1Migrations(accessToken, request.accountId, resources.databaseId, release.assets)
  await seedNewServer(accessToken, request.accountId, resources.databaseId, {
    serverId: request.serverId,
    filesEnabled: true,
    backupBucketName: resources.backupBucket,
    registrationMode: 'invite_only',
    mailEnabled: false,
    mailSubdomain: '',
    zoneName: '',
    zoneId: '',
    mailLocalPart: '',
    appName: request.name,
  }, origin, setupToken)
  await progress('database', 'complete', appliedMigrations.length ? `${appliedMigrations.length} applied` : 'Up to date')

  await progress('assets', 'active')
  const assetsJwt = await uploadAssets(accessToken, request.accountId, hostedScriptName(request.serverId), release.assets, { namespace: request.namespace })
  await progress('assets', 'complete')

  await progress('worker', 'active')
  await uploadHostedWorker(accessToken, request, release, resources, assetsJwt, origin, secrets)
  await progress('worker', 'complete', `L4 ${release.manifest.version}`)

  if (options.verify !== false) {
    await progress('verify', 'active')
    await verifyDeployment(origin, release.manifest.version, false, options.report, options.fetch ? { fetch: options.fetch } : {})
    await progress('verify', 'complete', 'Server health verified')
  }
  return {
    origin,
    setupUrl: `${origin}/setup#claim=${encodeURIComponent(setupToken)}`,
    version: release.manifest.version,
    scriptName: hostedScriptName(request.serverId),
    resources,
    ...secrets,
    appliedMigrations,
    verified: options.verify !== false,
  }
}

export type HostedDeleteRequest = {
  accountId: string
  namespace: string
  serverId: string
  hostname: string
  /** Lets the Server empty its own files bucket first; a bucket with objects cannot be deleted. */
  cloudSecret?: string
  resources: Partial<HostedResources>
}

export type HostedDeleteResponse = { purgedFiles: boolean; removed: Array<'script' | 'database' | 'files' | 'kv'> }

const ignoringNotFound = async (work: Promise<unknown>) => {
  try { await work; return true } catch (error) { if (notFound(error)) return false; throw error }
}

/**
 * Removes a hosted Server: its script, database, files bucket and KV. The backup bucket stays, always (AGENTS.md):
 * a deleted Server's last backups are what its Owner can still ask for.
 */
export async function deleteHostedL4(accessToken: string, request: HostedDeleteRequest, fetcher: typeof fetch = fetch): Promise<HostedDeleteResponse> {
  const removed: HostedDeleteResponse['removed'] = []
  let purgedFiles = false
  if (request.cloudSecret && request.resources.filesBucket) {
    try {
      const response = await fetcher(`https://${request.hostname}${CLOUD_RELAY_PATH}/purge-files`, { method: 'POST', headers: { Authorization: `Bearer ${request.cloudSecret}` }, redirect: 'manual' })
      purgedFiles = response.ok
    } catch {
      // The script may already be gone from an earlier attempt; the bucket deletion below says whether that matters.
    }
  }
  const path = scriptApiPath(request.accountId, hostedScriptName(request.serverId), { namespace: request.namespace })
  if (await ignoringNotFound(cloudflareApi(accessToken, `${path}?force=true`, { method: 'DELETE' }))) removed.push('script')
  if (request.resources.databaseId && await ignoringNotFound(cloudflareApi(accessToken, `/accounts/${request.accountId}/d1/database/${request.resources.databaseId}`, { method: 'DELETE' }))) removed.push('database')
  if (request.resources.kvId && await ignoringNotFound(cloudflareApi(accessToken, `/accounts/${request.accountId}/storage/kv/namespaces/${request.resources.kvId}`, { method: 'DELETE' }))) removed.push('kv')
  if (request.resources.filesBucket && await ignoringNotFound(cloudflareApi(accessToken, `/accounts/${request.accountId}/r2/buckets/${request.resources.filesBucket}`, { method: 'DELETE' }))) removed.push('files')
  return { purgedFiles, removed }
}
