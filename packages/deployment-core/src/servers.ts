import type { CloudflareServer, CloudflareZone, DeployRequest } from './types.js'
import { cloudflareClient } from './cloudflare-client.js'
import { type ExistingWorkerBinding, isL4Worker } from './deploy.js'
import { createError } from './errors.js'

export function installationHostname(value: unknown) {
  if (typeof value !== 'string') throw createError({ statusCode: 400, statusMessage: 'Installation origin is missing' })
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error()
    return url.hostname.toLowerCase()
  }
  catch {
    throw createError({ statusCode: 400, statusMessage: 'Installation origin is invalid' })
  }
}

function subdomain(hostname: string, zoneName: string) {
  const suffix = `.${zoneName}`
  return hostname.endsWith(suffix) ? hostname.slice(0, -suffix.length) : ''
}

function textBinding(bindings: ExistingWorkerBinding[], name: string) {
  return bindings.find(binding => binding.name === name && binding.type === 'plain_text')?.text?.trim() || ''
}

function serverConfiguration(
  accountId: string,
  workerName: string,
  hostname: string,
  bindings: ExistingWorkerBinding[],
  zones: CloudflareZone[],
): DeployRequest | null {
  const appZone = zones
    .filter(item => item.accountId === accountId && item.status === 'active' && (hostname === item.name || hostname.endsWith(`.${item.name}`)))
    .sort((left, right) => right.name.length - left.name.length)[0]
  const customDomainEnabled = Boolean(appZone)
  if (!customDomainEnabled && !hostname.endsWith('.workers.dev')) return null
  const appSubdomain = appZone ? subdomain(hostname, appZone.name) : workerName
  if (appZone && !appSubdomain) return null
  const mailDomain = textBinding(bindings, 'MAIL_DOMAIN')
  const mailZoneId = textBinding(bindings, 'MAIL_ZONE_ID')
  const selectedZone = zones.find(item => item.accountId === accountId && item.id === mailZoneId) || appZone
  const mailSubdomain = selectedZone ? subdomain(mailDomain, selectedZone.name) : ''
  const mailEnabled = Boolean(mailDomain && mailZoneId && mailSubdomain)
  const registration = textBinding(bindings, 'AUTH_REGISTRATION_MODE')
  const mode = textBinding(bindings, 'AUTH_MODE') === 'access' ? 'access' : 'builtin'
  return {
    accountId,
    workerName,
    adminEmail: '',
    allowedEmails: [],
    appName: textBinding(bindings, 'APP_NAME') || textBinding(bindings, 'ADMIN_WORKSPACE') || 'L4',
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

function serverFromBindings(
  accountId: string,
  workerName: string,
  bindings: ExistingWorkerBinding[],
  zones: CloudflareZone[],
): CloudflareServer | null {
  if (!isL4Worker(bindings)) return null
  const hostname = textBinding(bindings, 'LLLL_APP_HOSTNAME') || textBinding(bindings, 'MAIL_APP_HOSTNAME')
  if (!hostname) return null
  const configuration = serverConfiguration(accountId, workerName, hostname, bindings, zones)
  if (!configuration) return null
  return {
    accountId,
    workerName,
    origin: `https://${hostname}`,
    version: textBinding(bindings, 'LLLL_VERSION') || null,
    configuration,
    resources: {
      databaseId: bindings.find(binding => binding.name === 'DB' && binding.type === 'd1')?.database_id || null,
      primary: textBinding(bindings, 'LLLL_PRIMARY') === 'true',
      bucketName: bindings.find(binding => binding.name === 'FILES' && binding.type === 'r2_bucket')?.bucket_name || null,
      kvId: bindings.find(binding => binding.name === 'TICKETS' && binding.type === 'kv_namespace')?.namespace_id || null,
      mailZoneId: textBinding(bindings, 'MAIL_ZONE_ID') || null,
      mailDomain: textBinding(bindings, 'MAIL_DOMAIN') || null,
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

async function workerSettings(
  client: ReturnType<typeof cloudflareClient>,
  accountId: string,
  workerIds: string[],
): Promise<Array<ExistingWorkerBinding[] | null>> {
  return mapConcurrent(workerIds, SETTINGS_CONCURRENCY, async (workerId) => {
    const settings = await client.workers.scripts.scriptAndVersionSettings.get(workerId, { account_id: accountId }).catch(() => null)
    return (settings?.bindings as ExistingWorkerBinding[] | undefined) || null
  })
}

export async function listL4Servers(
  accessToken: string,
  accountId: string,
  options: { zones?: CloudflareZone[] } = {},
): Promise<CloudflareServer[]> {
  if (!/^[0-9a-f]{32}$/u.test(accountId)) throw createError({ statusCode: 400, statusMessage: 'Cloudflare account is invalid' })
  const client = cloudflareClient(accessToken)
  // Zones are only needed to interpret bindings, so they load alongside the workers instead of before them.
  const [zones, { workerIds, settingsList }] = await Promise.all([
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
      return { workerIds, settingsList: await workerSettings(client, accountId, workerIds) }
    })(),
  ])
  const installations: CloudflareServer[] = []
  settingsList.forEach((bindings, index) => {
    if (!bindings) return
    const installation = serverFromBindings(accountId, workerIds[index]!, bindings, zones)
    if (installation) installations.push(installation)
  })
  return installations.sort((left, right) => left.workerName.localeCompare(right.workerName))
}

export async function readL4Server(
  accessToken: string,
  accountId: string,
  workerName: string,
): Promise<CloudflareServer | null> {
  if (!/^[0-9a-f]{32}$/u.test(accountId)) throw createError({ statusCode: 400, statusMessage: 'Cloudflare account is invalid' })
  if (!workerName.trim()) return null
  const client = cloudflareClient(accessToken)
  const [bindings, zones] = await Promise.all([
    client.workers.scripts.scriptAndVersionSettings.get(workerName, { account_id: accountId })
      .catch(() => null)
      .then(settings => (settings?.bindings as ExistingWorkerBinding[] | undefined) || null),
    accountZones(client, accountId),
  ])
  if (!bindings) return null
  return serverFromBindings(accountId, workerName, bindings, zones)
}

export async function findL4Servers(accessToken: string, origin: unknown): Promise<CloudflareServer[]> {
  const hostname = installationHostname(origin)
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

  const installations: CloudflareServer[] = []
  for (const account of accounts) {
    if (!candidateAccountIds.has(account.id)) continue
    const workerIds: string[] = []
    for await (const worker of client.workers.scripts.list({ account_id: account.id })) {
      if (worker.id) workerIds.push(worker.id)
    }
    const settingsList = await workerSettings(client, account.id, workerIds)
    settingsList.forEach((bindings, index) => {
      if (!bindings) return
      const workerName = workerIds[index]!
      if (!isL4Worker(bindings)) return
      const appHostname = textBinding(bindings, 'LLLL_APP_HOSTNAME') || textBinding(bindings, 'MAIL_APP_HOSTNAME')
      if (appHostname.toLowerCase() !== hostname) return
      const configuration = serverConfiguration(account.id, workerName, hostname, bindings, zones)
      if (!configuration) return
      installations.push({
        accountId: account.id,
        workerName,
        origin: `https://${hostname}`,
        version: textBinding(bindings, 'LLLL_VERSION') || null,
        configuration,
        resources: {
          databaseId: bindings.find(binding => binding.name === 'DB' && binding.type === 'd1')?.database_id || null,
          primary: textBinding(bindings, 'LLLL_PRIMARY') === 'true',
          bucketName: bindings.find(binding => binding.name === 'FILES' && binding.type === 'r2_bucket')?.bucket_name || null,
          kvId: bindings.find(binding => binding.name === 'TICKETS' && binding.type === 'kv_namespace')?.namespace_id || null,
          mailZoneId: textBinding(bindings, 'MAIL_ZONE_ID') || null,
          mailDomain: textBinding(bindings, 'MAIL_DOMAIN') || null,
          accessApplicationId: textBinding(bindings, 'CF_ACCESS_APP_ID') || null,
          accessHealthApplicationId: textBinding(bindings, 'CF_ACCESS_HEALTH_APP_ID') || null,
          accessDeletionApplicationId: textBinding(bindings, 'CF_ACCESS_DELETION_APP_ID') || null,
        },
      })
    })
  }
  return installations
}
