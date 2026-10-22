import type { CloudflareServer, CloudflareZone, DeployRequest } from './types.js'
import { cloudflareClient } from './cloudflare-client.js'
import { type ExistingWorkerBinding, isL4Worker } from './deploy.js'
import { createError } from './errors.js'

export function serverHostname(value: unknown) {
  if (typeof value !== 'string') throw createError({ statusCode: 400, statusMessage: 'Server origin is missing' })
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error()
    return url.hostname.toLowerCase()
  }
  catch {
    throw createError({ statusCode: 400, statusMessage: 'Server origin is invalid' })
  }
}

function subdomain(hostname: string, zoneName: string) {
  const suffix = `.${zoneName}`
  return hostname.endsWith(suffix) ? hostname.slice(0, -suffix.length) : ''
}

function textBinding(bindings: ExistingWorkerBinding[], name: string) {
  return bindings.find(binding => binding.name === name && binding.type === 'plain_text')?.text?.trim() || ''
}

export type WorkerAnnotations = { 'workers/tag'?: string }

export type WorkerMetadata = {
  bindings: ExistingWorkerBinding[]
  tags?: string[] | null
  annotations?: WorkerAnnotations | null
}

function versionOf(worker: WorkerMetadata) {
  return worker.annotations?.['workers/tag']?.replace(/^llll-/u, '')
    || textBinding(worker.bindings, 'LLLL_VERSION')
    || null
}

function originHost(worker: WorkerMetadata) {
  const publicOrigin = textBinding(worker.bindings, 'PUBLIC_ORIGIN')
  if (publicOrigin) {
    try { return new URL(publicOrigin).hostname } catch { /* Fall back to legacy metadata. */ }
  }
  return textBinding(worker.bindings, 'LLLL_APP_HOSTNAME') || textBinding(worker.bindings, 'MAIL_APP_HOSTNAME')
}

function isBootstrap(worker: WorkerMetadata) {
  return Boolean(worker.tags?.includes('llll-server-bootstrap'))
}

function serverConfiguration(
  accountId: string,
  workerName: string,
  hostname: string,
  worker: WorkerMetadata,
  zones: CloudflareZone[],
): DeployRequest | null {
  const bindings = worker.bindings
  const appZone = zones
    .filter(item => item.accountId === accountId && item.status === 'active' && (hostname === item.name || hostname.endsWith(`.${item.name}`)))
    .sort((left, right) => right.name.length - left.name.length)[0]
  const customDomainEnabled = Boolean(appZone)
  if (!customDomainEnabled && !hostname.endsWith('.workers.dev')) return null
  const appSubdomain = appZone ? subdomain(hostname, appZone.name) : workerName
  if (appZone && !appSubdomain) return null
  const mail = JSON.parse(textBinding(bindings, 'LLLL_EMAIL_DOMAINS') || '[]')[0]
  const mailDomain = mail?.domain || ''
  const mailZoneId = mail?.zoneId || ''
  const selectedZone = zones.find(item => item.accountId === accountId && item.id === mailZoneId) || appZone
  const mailSubdomain = selectedZone ? subdomain(mailDomain, selectedZone.name) : ''
  const mailEnabled = Boolean(mailDomain && mailZoneId && mailSubdomain)
  const registration = textBinding(bindings, 'AUTH_REGISTRATION_MODE')
  const mode = textBinding(bindings, 'AUTH_MODE') === 'access' ? 'access' : 'builtin'
  return {
    accountId,
    serverId: /^llll-([0-9a-f-]{36})$/iu.exec(workerName)?.[1] || '',
    workerName,
    adminEmail: '',
    allowedEmails: [],
    appName: 'L4',
    authMode: mode,
    registrationMode: registration === 'open' ? 'open' : 'invite_only',
    customDomainEnabled,
    zoneId: selectedZone?.id || '',
    zoneName: selectedZone?.name || '',
    appSubdomain,
    mailEnabled,
    mailSubdomain: mailEnabled ? mailSubdomain : customDomainEnabled ? appSubdomain : 'llll',
    mailLocalPart: textBinding(bindings, 'MAIL_DEFAULT_LOCAL_PART') || 'inbox',
  }
}

function serverFromMetadata(
  accountId: string,
  workerName: string,
  worker: WorkerMetadata,
  zones: CloudflareZone[],
): CloudflareServer | null {
  if (isBootstrap(worker) || !isL4Worker(worker.bindings, worker.tags)) return null
  const hostname = originHost(worker)
  if (!hostname) return null
  const configuration = serverConfiguration(accountId, workerName, hostname, worker, zones)
  if (!configuration) return null
  const bindings = worker.bindings
  return {
    accountId,
    workerName,
    origin: `https://${hostname}`,
    version: versionOf(worker),
    configuration,
    resources: {
      databaseId: bindings.find(binding => binding.name === 'DB' && binding.type === 'd1')?.database_id || null,
      bucketName: bindings.find(binding => binding.name === 'FILES' && binding.type === 'r2_bucket')?.bucket_name || null,
      backupBucketName: textBinding(bindings, 'BACKUP_BUCKET_NAME') || bindings.find(binding => binding.name === 'BACKUPS' && binding.type === 'r2_bucket')?.bucket_name || null,
      kvId: bindings.find(binding => binding.name === 'TICKETS' && binding.type === 'kv_namespace')?.namespace_id || null,
      mailZoneId: JSON.parse(textBinding(bindings, 'LLLL_EMAIL_DOMAINS') || '[]')[0]?.zoneId || null,
      mailDomain: JSON.parse(textBinding(bindings, 'LLLL_EMAIL_DOMAINS') || '[]')[0]?.domain || null,
      accessApplicationId: textBinding(bindings, 'CF_ACCESS_APP_ID') || null,
      accessHealthApplicationId: textBinding(bindings, 'CF_ACCESS_HEALTH_APP_ID') || null,
      accessDeletionApplicationId: textBinding(bindings, 'CF_ACCESS_DELETION_APP_ID') || null,
    },
  }
}

async function accountZones(client: ReturnType<typeof cloudflareClient>, accountId: string): Promise<CloudflareZone[]> {
  const zones: CloudflareZone[] = []
  for await (const zone of client.zones.list({ account: { id: accountId }, per_page: 50 })) {
    if (!zone.id || !zone.name) continue
    zones.push({ id: zone.id, name: zone.name, accountId, status: zone.status || 'unknown' })
  }
  return zones
}

export function listAccountZones(accessToken: string, accountId: string): Promise<CloudflareZone[]> {
  return accountZones(cloudflareClient(accessToken), accountId)
}

const SETTINGS_CONCURRENCY = 10

async function mapConcurrent<T, R>(items: T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let cursor = 0
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++
      results[index] = await task(items[index]!)
    }
  }))
  return results
}

async function workerMetadata(
  client: ReturnType<typeof cloudflareClient>,
  accountId: string,
  workerIds: string[],
  strict = false,
): Promise<Array<WorkerMetadata | null>> {
  return mapConcurrent(workerIds, SETTINGS_CONCURRENCY, async (workerId) => {
    const settings = await client.workers.scripts.scriptAndVersionSettings.get(workerId, { account_id: accountId }).catch(error => {
      if (strict && error?.status !== 404) throw error
      return null
    })
    if (!settings) return null
    return {
      bindings: (settings.bindings as ExistingWorkerBinding[] | undefined) || [],
      tags: settings.tags || [],
      annotations: settings.annotations || null,
    }
  })
}

export async function listL4Servers(
  accessToken: string,
  accountId: string,
  options: { zones?: CloudflareZone[]; strict?: boolean } = {},
): Promise<CloudflareServer[]> {
  if (!/^[0-9a-f]{32}$/u.test(accountId)) throw createError({ statusCode: 400, statusMessage: 'Cloudflare account is invalid' })
  const client = cloudflareClient(accessToken)
  // Zones are only needed to interpret bindings, so they load alongside the workers instead of before them.
  const [zones, { workerIds, metadataList }] = await Promise.all([
    options.zones || (async () => {
      const [account, fetchedZones] = await Promise.all([
        client.accounts.get({ account_id: accountId }),
        accountZones(client, accountId),
      ])
      if (account.id !== accountId) throw createError({ statusCode: 403, statusMessage: 'Cloudflare account is unavailable' })
      return fetchedZones
    })(),
    (async () => {
      const workerIds: string[] = []
      for await (const worker of client.workers.scripts.list({ account_id: accountId })) {
        if (worker.id) workerIds.push(worker.id)
      }
      return { workerIds, metadataList: await workerMetadata(client, accountId, workerIds, options.strict) }
    })(),
  ])
  const servers: CloudflareServer[] = []
  metadataList.forEach((worker, index) => {
    if (!worker) return
    const server = serverFromMetadata(accountId, workerIds[index]!, worker, zones)
    if (server) servers.push(server)
  })
  return servers.sort((left, right) => left.workerName.localeCompare(right.workerName))
}

export async function readL4Server(
  accessToken: string,
  accountId: string,
  workerName: string,
): Promise<CloudflareServer | null> {
  if (!/^[0-9a-f]{32}$/u.test(accountId)) throw createError({ statusCode: 400, statusMessage: 'Cloudflare account is invalid' })
  if (!workerName.trim()) return null
  const client = cloudflareClient(accessToken)
  const [worker, zones] = await Promise.all([
    client.workers.scripts.scriptAndVersionSettings.get(workerName, { account_id: accountId })
      .catch(() => null)
      .then(settings => settings
        ? {
            bindings: (settings.bindings as ExistingWorkerBinding[] | undefined) || [],
            tags: settings.tags || [],
            annotations: settings.annotations || null,
          }
        : null),
    accountZones(client, accountId),
  ])
  if (!worker) return null
  return serverFromMetadata(accountId, workerName, worker, zones)
}

export async function findL4Servers(accessToken: string, origin: unknown): Promise<CloudflareServer[]> {
  const hostname = serverHostname(origin)
  const client = cloudflareClient(accessToken)
  const accounts = []
  for await (const account of client.accounts.list({ per_page: 50 })) accounts.push(account)
  const zones: CloudflareZone[] = []
  for await (const zone of client.zones.list({ per_page: 50 })) {
    if (!zone.id || !zone.name || !zone.account?.id) continue
    zones.push({ id: zone.id, name: zone.name, accountId: zone.account.id, status: zone.status || 'unknown' })
  }
  const candidateAccountIds = hostname.endsWith('.workers.dev')
    ? new Set(accounts.map(account => account.id))
    : new Set(zones
        .filter(zone => zone.status === 'active' && (hostname === zone.name || hostname.endsWith(`.${zone.name}`)))
        .map(zone => zone.accountId))

  const servers: CloudflareServer[] = []
  for (const account of accounts) {
    if (!candidateAccountIds.has(account.id)) continue
    const workerIds: string[] = []
    for await (const worker of client.workers.scripts.list({ account_id: account.id })) {
      if (worker.id) workerIds.push(worker.id)
    }
    const metadataList = await workerMetadata(client, account.id, workerIds)
    metadataList.forEach((worker, index) => {
      if (!worker) return
      if (isBootstrap(worker) || !isL4Worker(worker.bindings, worker.tags)) return
      if (originHost(worker)?.toLowerCase() !== hostname) return
      const workerName = workerIds[index]!
      const configuration = serverConfiguration(account.id, workerName, hostname, worker, zones)
      if (!configuration) return
      const bindings = worker.bindings
      servers.push({
        accountId: account.id,
        workerName,
        origin: `https://${hostname}`,
        version: versionOf(worker),
        configuration,
        resources: {
          databaseId: bindings.find(binding => binding.name === 'DB' && binding.type === 'd1')?.database_id || null,
          bucketName: bindings.find(binding => binding.name === 'FILES' && binding.type === 'r2_bucket')?.bucket_name || null,
          backupBucketName: textBinding(bindings, 'BACKUP_BUCKET_NAME') || bindings.find(binding => binding.name === 'BACKUPS' && binding.type === 'r2_bucket')?.bucket_name || null,
          kvId: bindings.find(binding => binding.name === 'TICKETS' && binding.type === 'kv_namespace')?.namespace_id || null,
          mailZoneId: JSON.parse(textBinding(bindings, 'LLLL_EMAIL_DOMAINS') || '[]')[0]?.zoneId || null,
          mailDomain: JSON.parse(textBinding(bindings, 'LLLL_EMAIL_DOMAINS') || '[]')[0]?.domain || null,
          accessApplicationId: textBinding(bindings, 'CF_ACCESS_APP_ID') || null,
          accessHealthApplicationId: textBinding(bindings, 'CF_ACCESS_HEALTH_APP_ID') || null,
          accessDeletionApplicationId: textBinding(bindings, 'CF_ACCESS_DELETION_APP_ID') || null,
        },
      })
    })
  }
  return servers
}
