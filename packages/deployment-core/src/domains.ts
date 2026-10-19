import type Cloudflare from 'cloudflare'
import { cloudflareApi, cloudflareClient, publicErrorMessage } from './cloudflare-client.js'
import { createError } from './errors.js'
import type { CloudflareZone } from './types.js'
import type { ExistingWorkerBinding } from './deploy.js'
import { ensureWorkersHostname } from './access.js'
import { patchWorkerBindings } from './worker-settings.js'

export type ManagedEmailDomain = {
  id: string
  zoneId: string
  domain: string
}

type WorkerDomain = {
  id: string
  hostname: string
  service: string
  zone_id: string
  zone_name: string
}

type SendingSubdomain = {
  tag: string
  name: string
  enabled: boolean
}

type EmailRoutingRule = {
  id: string
  enabled?: boolean
  matchers?: Array<{ type?: string, field?: string, value?: string }>
  actions?: Array<{ type?: string, value?: string[] }>
}

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

function textBinding(bindings: ExistingWorkerBinding[], name: string) {
  return bindings.find(binding => binding.name === name && binding.type === 'plain_text')?.text?.trim() || ''
}

function emailDomains(bindings: ExistingWorkerBinding[]): ManagedEmailDomain[] {
  const serialized = textBinding(bindings, 'LLLL_EMAIL_DOMAINS')
  if (serialized) {
    try {
      const value = JSON.parse(serialized) as unknown
      if (Array.isArray(value)) {
        return value.filter((item): item is ManagedEmailDomain => Boolean(
          item && typeof item === 'object'
          && typeof (item as ManagedEmailDomain).id === 'string'
          && typeof (item as ManagedEmailDomain).zoneId === 'string'
          && typeof (item as ManagedEmailDomain).domain === 'string',
        ))
      }
    }
    catch {
      // Invalid metadata does not enable a domain.
    }
  }
  return []
}

async function workerBindings(client: Cloudflare, accountId: string, workerName: string) {
  const settings = await client.workers.scripts.scriptAndVersionSettings.get(workerName, { account_id: accountId })
  return (settings.bindings || []) as ExistingWorkerBinding[]
}

async function editBindings(
  accessToken: string,
  client: Cloudflare,
  accountId: string,
  workerName: string,
  replacements: Array<Record<string, unknown>>,
  removals: string[] = [],
) {
  const changed = new Set([...replacements.map(binding => String(binding.name)), ...removals])
  const current = await workerBindings(client, accountId, workerName)
  const inherited = current
    .filter(binding => binding.name && !changed.has(binding.name))
    .map(binding => ({ name: binding.name, type: 'inherit' as const }))
  await patchWorkerBindings(accessToken, accountId, workerName, [...inherited, ...replacements])
}

export async function rotateOwnerSetupToken(
  accessToken: string,
  accountId: string,
  workerName: string,
  token: string,
) {
  if (token.length < 32 || token.length > 256) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid owner setup token' })
  }
  const client = cloudflareClient(accessToken)
  await editBindings(accessToken, client, accountId, workerName, [
    { type: 'secret_text', name: 'SETUP_TOKEN', text: token },
  ])
}

export function hostnameInsideZone(zone: CloudflareZone, hostname: string) {
  const normalized = hostname.trim().toLowerCase()
  const zoneName = zone.name.trim().toLowerCase()
  const label = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u
  const hostnamePattern = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u
  if (zone.status !== 'active') {
    throw createError({ statusCode: 400, statusMessage: 'Enter a hostname inside the selected active Cloudflare zone' })
  }
  if (normalized === zoneName || (normalized.endsWith(`.${zoneName}`) && hostnamePattern.test(normalized))) return normalized
  if (label.test(normalized)) return `${normalized}.${zoneName}`
  throw createError({ statusCode: 400, statusMessage: 'Enter a hostname inside the selected active Cloudflare zone' })
}

export function emailRoutingEnableBody(zone: CloudflareZone, domain: string) {
  return domain === zone.name.trim().toLowerCase() ? undefined : JSON.stringify({ name: domain })
}

export type EmailSendingState = {
  /** A sending domain the installer created, and so removes again on disconnect. */
  createdSubdomainId: string | null
  enabled: boolean
}

/**
 * Onboards a domain for Cloudflare Email Sending, the zone apex included, the
 * same way `wrangler email sending enable example.com` does. A domain that is
 * already onboarded is reused and never removed by the installer. Failing here
 * stops the connection, so a domain is never left able to receive but not send.
 */
export async function ensureEmailSendingDomain(accessToken: string, zone: CloudflareZone, domain: string): Promise<EmailSendingState> {
  const path = `/zones/${zone.id}/email/sending/subdomains`
  const existing = (await cloudflareApi<SendingSubdomain[]>(accessToken, path))
    .find(item => item.name.toLowerCase() === domain)
  if (existing?.enabled) return { createdSubdomainId: null, enabled: true }
  try {
    // Creates the sending domain, or re-enables one that was turned off.
    const sender = await cloudflareApi<SendingSubdomain>(accessToken, path, { method: 'POST', body: JSON.stringify({ name: domain }) })
    return { createdSubdomainId: existing ? null : sender.tag, enabled: sender.enabled !== false }
  }
  catch (error) {
    throw createError({
      statusCode: statusCode(error) || 502,
      statusMessage: `Cloudflare did not enable Email Sending for ${domain}: ${publicErrorMessage(error)}`,
    })
  }
}

export async function connectAppDomain(
  accessToken: string,
  accountId: string,
  workerName: string,
  zone: CloudflareZone,
  hostname: string,
) {
  const normalized = hostnameInsideZone(zone, hostname)
  const client = cloudflareClient(accessToken)
  const domains = await cloudflareApi<WorkerDomain[]>(accessToken, `/accounts/${accountId}/workers/domains`)
  const occupied = domains.find(domain => domain.hostname.toLowerCase() === normalized)
  if (occupied && occupied.service !== workerName) {
    throw createError({ statusCode: 409, statusMessage: `${normalized} is already attached to Worker ${occupied.service}` })
  }
  const current = domains.find(domain => domain.service === workerName)
  if (current && current.hostname.toLowerCase() !== normalized) {
    throw createError({ statusCode: 409, statusMessage: `Disconnect ${current.hostname} before connecting another app domain` })
  }
  const attached = occupied || await cloudflareApi<WorkerDomain>(accessToken, `/accounts/${accountId}/workers/domains`, {
    method: 'PUT',
    body: JSON.stringify({ hostname: normalized, service: workerName, zone_id: zone.id, zone_name: zone.name }),
  })
  await editBindings(accessToken, client, accountId, workerName, [
    { type: 'plain_text', name: 'PUBLIC_ORIGIN', text: `https://${normalized}` },
    { type: 'plain_text', name: 'LLLL_APP_HOSTNAME', text: normalized },
    { type: 'plain_text', name: 'LLLL_CUSTOM_DOMAIN', text: 'true' },
    { type: 'plain_text', name: 'LLLL_APP_ZONE_ID', text: zone.id },
    { type: 'plain_text', name: 'LLLL_APP_ZONE_NAME', text: zone.name },
  ])
  await client.workers.scripts.subdomain.create(workerName, { account_id: accountId, enabled: false, previews_enabled: false })
  return { id: attached.id, hostname: normalized }
}

export async function disconnectAppDomain(accessToken: string, accountId: string, workerName: string, domainId: string) {
  const client = cloudflareClient(accessToken)
  await unlessMissing(() => cloudflareApi(accessToken, `/accounts/${accountId}/workers/domains/${domainId}`, { method: 'DELETE' }))
  const hostname = await ensureWorkersHostname(client, accountId, workerName)
  await editBindings(accessToken, client, accountId, workerName, [
    { type: 'plain_text', name: 'PUBLIC_ORIGIN', text: `https://${hostname}` },
    { type: 'plain_text', name: 'LLLL_APP_HOSTNAME', text: hostname },
    { type: 'plain_text', name: 'LLLL_CUSTOM_DOMAIN', text: 'false' },
  ], ['LLLL_APP_ZONE_ID', 'LLLL_APP_ZONE_NAME'])
  await client.workers.scripts.subdomain.create(workerName, { account_id: accountId, enabled: true, previews_enabled: false })
  return { hostname }
}

export async function connectEmailDomain(
  accessToken: string,
  accountId: string,
  workerName: string,
  zone: CloudflareZone,
  value: ManagedEmailDomain,
) {
  const domain = hostnameInsideZone(zone, value.domain)
  const client = cloudflareClient(accessToken)
  const bindings = await workerBindings(client, accountId, workerName)
  const configured = emailDomains(bindings)
  const managed = configured.find(item => item.domain === domain) || { ...value, domain, zoneId: zone.id }
  if (!configured.some(item => item.domain === domain)) configured.push(managed)
  const routingBody = emailRoutingEnableBody(zone, domain)
  await cloudflareApi(accessToken, `/zones/${zone.id}/email/routing/dns`, {
    method: 'POST',
    ...(routingBody ? { body: routingBody } : {}),
  })
  const sending = await ensureEmailSendingDomain(accessToken, zone, domain)
  const appHostname = textBinding(bindings, 'LLLL_APP_HOSTNAME')
  await editBindings(accessToken, client, accountId, workerName, [
    { type: 'send_email', name: 'MAIL_EMAIL' },
    { type: 'plain_text', name: 'LLLL_EMAIL_DOMAINS', text: JSON.stringify(configured) },
    { type: 'plain_text', name: 'MAIL_APP_HOSTNAME', text: appHostname },
  ])
  return { ...managed, sendingSubdomainId: sending.createdSubdomainId, sendingEnabled: sending.enabled }
}

export async function disconnectEmailDomain(
  accessToken: string,
  accountId: string,
  workerName: string,
  domain: ManagedEmailDomain & { sendingSubdomainId?: string | null },
) {
  const client = cloudflareClient(accessToken)
  const bindings = await workerBindings(client, accountId, workerName)
  const remaining = emailDomains(bindings).filter(item => item.id !== domain.id && item.domain !== domain.domain)
  if (domain.sendingSubdomainId) {
    await unlessMissing(() => cloudflareApi(accessToken, `/zones/${domain.zoneId}/email/sending/subdomains/${domain.sendingSubdomainId}`, { method: 'DELETE' }))
  }
  const replacements: Array<Record<string, unknown>> = [
    { type: 'plain_text', name: 'LLLL_EMAIL_DOMAINS', text: JSON.stringify(remaining) },
  ]
  const removals: string[] = []
  if (remaining.length) {
    replacements.push(
      { type: 'send_email', name: 'MAIL_EMAIL' },
    )
  }
  else {
    removals.push('MAIL_EMAIL', 'MAIL_APP_HOSTNAME')
  }
  await editBindings(accessToken, client, accountId, workerName, replacements, removals)
  return remaining
}

function literalAddress(rule: EmailRoutingRule) {
  return rule.matchers?.find(matcher => matcher.type === 'literal' && matcher.field === 'to')?.value?.toLowerCase() || ''
}

export async function ensureMailboxRoute(accessToken: string, zoneId: string, workerName: string, address: string) {
  const normalized = address.trim().toLowerCase()
  const rules = await cloudflareApi<EmailRoutingRule[]>(accessToken, `/zones/${zoneId}/email/routing/rules?per_page=100`)
  const existing = rules.find(rule => literalAddress(rule) === normalized)
  const target = existing?.actions?.find(action => action.type === 'worker')?.value?.[0]
  if (existing && target !== workerName) {
    throw createError({ statusCode: 409, statusMessage: `${normalized} already has a Cloudflare Email Routing rule` })
  }
  if (existing) return existing
  return cloudflareApi<EmailRoutingRule>(accessToken, `/zones/${zoneId}/email/routing/rules`, {
    method: 'POST',
    body: JSON.stringify({
      name: `L4 mailbox ${normalized}`,
      enabled: true,
      matchers: [{ type: 'literal', field: 'to', value: normalized }],
      actions: [{ type: 'worker', value: [workerName] }],
    }),
  })
}

export async function deleteMailboxRoute(accessToken: string, zoneId: string, ruleId: string) {
  await unlessMissing(() => cloudflareApi(accessToken, `/zones/${zoneId}/email/routing/rules/${ruleId}`, { method: 'DELETE' }))
}
