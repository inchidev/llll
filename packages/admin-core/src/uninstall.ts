import type Cloudflare from 'cloudflare'
import type { CloudflareInstallation } from './types.js'
import { removePrimaryMail } from './primary-mail.js'
import { createError } from './errors.js'

function statusCode(error: unknown) {
  if (!error || typeof error !== 'object') return 0
  const value = error as { status?: unknown, statusCode?: unknown }
  return Number(value.statusCode || value.status || 0)
}

async function unlessMissing(action: () => Promise<unknown>) {
  try {
    await action()
  }
  catch (error) {
    if (statusCode(error) !== 404) throw error
  }
}

async function detachDomains(client: Cloudflare, installation: CloudflareInstallation, deleted: string[]) {
  for await (const domain of client.workers.domains.list({ account_id: installation.accountId })) {
    if (!domain.id || domain.service !== installation.workerName || domain.hostname?.toLowerCase() !== new URL(installation.origin).hostname) continue
    await client.workers.domains.delete(domain.id, { account_id: installation.accountId })
    deleted.push(`custom domain ${domain.hostname}`)
  }
}

async function detachEmail(client: Cloudflare, accessToken: string, installation: CloudflareInstallation, deleted: string[]) {
  const zoneId = installation.resources.mailZoneId
  const mailDomain = installation.resources.mailDomain
  if (!zoneId || !mailDomain) return

  const removal = await removePrimaryMail(
    client,
    accessToken,
    installation.accountId,
    zoneId,
    installation.configuration.zoneName,
    installation.workerName,
    mailDomain,
  )
  if (removal.removed) deleted.push(`primary mail route for ${mailDomain}`)

  await unlessMissing(async () => {
    const catchAll = await client.emailRouting.rules.catchAlls.get({ zone_id: zoneId })
    const targets = catchAll.actions?.filter(action => action.type === 'worker').flatMap(action => action.value || []) || []
    const ownedDirectly = targets.includes(installation.workerName)
    const ownedGateway = targets.includes(removal.gatewayName)
    if (!ownedDirectly && !(ownedGateway && removal.lastRoute)) return
    await client.emailRouting.rules.catchAlls.update({
      zone_id: zoneId,
      actions: catchAll.actions || [{ type: 'drop' }],
      matchers: catchAll.matchers || [{ type: 'all' }],
      enabled: false,
      name: catchAll.name,
      source: catchAll.source,
    })
    deleted.push(`email catch-all for ${installation.configuration.zoneName}`)
  })

  for await (const subdomain of client.emailSending.subdomains.list({ zone_id: zoneId })) {
    if (subdomain.name.toLowerCase() !== mailDomain.toLowerCase() || !subdomain.tag) continue
    await client.emailSending.subdomains.delete(subdomain.tag, { zone_id: zoneId })
    deleted.push(`email sending subdomain ${mailDomain}`)
  }
}

async function detachAccess(client: Cloudflare, installation: CloudflareInstallation, deleted: string[]) {
  const ids = [
    installation.resources.accessApplicationId,
    installation.resources.accessHealthApplicationId,
    installation.resources.accessDeletionApplicationId,
  ].filter((id): id is string => Boolean(id))
  for (const id of ids) {
    await unlessMissing(() => client.zeroTrust.access.applications.delete(id, { account_id: installation.accountId }))
  }
  if (ids.length) deleted.push(`${ids.length} Cloudflare Access applications`)
}

export async function prepareLiveFiles(origin: string, claim: string): Promise<number> {
  const response = await fetch(`${origin}/api/workspaces/main/deletion/prepare`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${claim}`, Accept: 'application/json' },
    redirect: 'error',
  })
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { statusMessage?: string, data?: { error?: { message?: string } } } | null
    throw createError({
      statusCode: response.status,
      statusMessage: payload?.data?.error?.message || payload?.statusMessage || 'The workspace did not authorize deletion',
    })
  }
  const payload = await response.json() as { ok?: boolean, deletedObjects?: number }
  if (!payload.ok || !Number.isSafeInteger(payload.deletedObjects)) {
    throw createError({ statusCode: 502, statusMessage: 'The workspace returned an invalid deletion response' })
  }
  return payload.deletedObjects || 0
}

export async function uninstallL4(
  client: Cloudflare,
  accessToken: string,
  installation: CloudflareInstallation,
  claim: string,
  options: { afterPrepare?: () => Promise<string[]> } = {},
) {
  const deleted: string[] = []
  const remaining: string[] = []
  const deletedObjects = await prepareLiveFiles(installation.origin, claim)

  if (options.afterPrepare) deleted.push(...await options.afterPrepare())

  await detachAccess(client, installation, deleted)
  await detachDomains(client, installation, deleted)
  await detachEmail(client, accessToken, installation, deleted)

  await client.workers.scripts.delete(installation.workerName, { account_id: installation.accountId, force: true })
  deleted.push(`Worker ${installation.workerName} and its Durable Object state`)

  const cleanup = async (label: string, action: () => Promise<void>) => {
    try {
      await action()
    }
    catch {
      remaining.push(label)
    }
  }

  if (installation.resources.bucketName) {
    await cleanup(`R2 bucket ${installation.resources.bucketName}`, async () => {
      await unlessMissing(() => client.r2.buckets.delete(installation.resources.bucketName!, { account_id: installation.accountId }))
      deleted.push(`R2 bucket ${installation.resources.bucketName}`)
    })
  }
  if (installation.resources.databaseId) {
    await cleanup(`D1 database ${installation.resources.databaseId}`, async () => {
      await unlessMissing(() => client.d1.database.delete(installation.resources.databaseId!, { account_id: installation.accountId }))
      deleted.push(`D1 database ${installation.resources.databaseId}`)
    })
  }
  if (installation.resources.kvId) {
    await cleanup(`KV namespace ${installation.resources.kvId}`, async () => {
      await unlessMissing(() => client.kv.namespaces.delete(installation.resources.kvId!, { account_id: installation.accountId }))
      deleted.push(`KV namespace ${installation.resources.kvId}`)
    })
  }
  return { deletedResources: deleted, deletedObjects, remainingResources: remaining }
}
