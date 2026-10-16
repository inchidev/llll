import {
  cloudflareApi,
  connectAppDomain,
  connectEmailDomain,
  deleteMailboxRoute,
  disconnectAppDomain,
  disconnectEmailDomain,
  ensureMailboxRoute,
  listAccountZones,
  type CloudflareZone,
} from '@llll/admin-core'
import type { AdminEnv } from '../env'
import { cloudflareToken } from './credential'
import { audit, ensureSchema, nowIso } from './db'
import { fail } from './http'
import { randomToken } from './secrets'

export type WorkspaceDomains = {
  zones: Array<{ id: string, name: string, status: string }>
  appDomain: null | { hostname: string, zoneId: string, zoneName: string }
  emailDomains: Array<{ id: string, domain: string, zoneId: string, zoneName: string, sendingEnabled: boolean }>
}

type WorkerDomain = { id: string, hostname: string, service: string, zone_id: string, zone_name: string }
type RoutingRule = { id: string, matchers?: Array<{ type?: string, field?: string, value?: string }>, actions?: Array<{ type?: string, value?: string[] }> }
type SendingSubdomain = { tag: string, name: string, enabled: boolean }

async function zoneFor(token: string, env: AdminEnv, zoneId: string): Promise<CloudflareZone> {
  const zone = (await listAccountZones(token, env.CLOUDFLARE_ACCOUNT_ID)).find(candidate => candidate.id === zoneId)
  if (!zone) fail(404, 'Cloudflare zone not found in this account')
  return zone
}

export async function readDomains(env: AdminEnv, workerName: string): Promise<WorkspaceDomains> {
  await ensureSchema(env.ADMIN_DB)
  const token = await cloudflareToken(env)
  const [zones, appDomain, emailDomains] = await Promise.all([
    listAccountZones(token, env.CLOUDFLARE_ACCOUNT_ID),
    env.ADMIN_DB.prepare('SELECT hostname, zone_id AS zoneId, zone_name AS zoneName FROM app_domains WHERE worker_name = ?')
      .bind(workerName).first<{ hostname: string, zoneId: string, zoneName: string }>(),
    env.ADMIN_DB.prepare(
      `SELECT id, domain, zone_id AS zoneId, zone_name AS zoneName, sending_enabled AS sendingEnabled
       FROM email_domains WHERE worker_name = ? ORDER BY created_at, domain`,
    ).bind(workerName).all<{ id: string, domain: string, zoneId: string, zoneName: string, sendingEnabled: number }>(),
  ])
  return {
    zones: zones.map(zone => ({ id: zone.id, name: zone.name, status: zone.status })),
    appDomain: appDomain || null,
    emailDomains: (emailDomains.results || []).map(domain => ({ ...domain, sendingEnabled: Boolean(domain.sendingEnabled) })),
  }
}

export async function setAppDomain(env: AdminEnv, workerName: string, input: { zoneId: string, hostname: string }) {
  const token = await cloudflareToken(env)
  const zone = await zoneFor(token, env, input.zoneId)
  const attached = await connectAppDomain(token, env.CLOUDFLARE_ACCOUNT_ID, workerName, zone, input.hostname)
  const now = nowIso()
  await env.ADMIN_DB.prepare(
    `INSERT INTO app_domains (worker_name, zone_id, zone_name, hostname, domain_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(worker_name) DO UPDATE SET zone_id = excluded.zone_id, zone_name = excluded.zone_name,
       hostname = excluded.hostname, domain_id = excluded.domain_id, updated_at = excluded.updated_at`,
  ).bind(workerName, zone.id, zone.name, attached.hostname, attached.id, now, now).run()
  await audit(env.ADMIN_DB, 'app_domain.connect', workerName, { hostname: attached.hostname })
  return { hostname: attached.hostname }
}

export async function removeAppDomain(env: AdminEnv, workerName: string) {
  const record = await env.ADMIN_DB.prepare('SELECT domain_id AS domainId FROM app_domains WHERE worker_name = ?')
    .bind(workerName).first<{ domainId: string }>()
  const token = await cloudflareToken(env)
  const detached = record
    ? await disconnectAppDomain(token, env.CLOUDFLARE_ACCOUNT_ID, workerName, record.domainId)
    : null
  await env.ADMIN_DB.prepare('DELETE FROM app_domains WHERE worker_name = ?').bind(workerName).run()
  await audit(env.ADMIN_DB, 'app_domain.disconnect', workerName)
  return detached ?? { hostname: '' }
}

export async function addEmailDomain(env: AdminEnv, workerName: string, input: { zoneId: string, domain: string }) {
  const normalized = input.domain.trim().toLowerCase()
  const existing = await env.ADMIN_DB.prepare(
    `SELECT id, domain, zone_id AS zoneId, zone_name AS zoneName, sending_enabled AS sendingEnabled
     FROM email_domains WHERE worker_name = ? AND domain = ?`,
  ).bind(workerName, normalized).first<{ id: string, domain: string, zoneId: string, zoneName: string, sendingEnabled: number }>()
  if (existing?.sendingEnabled) return { id: existing.id, domain: existing.domain, zoneId: existing.zoneId, zoneName: existing.zoneName, sendingEnabled: true }
  const token = await cloudflareToken(env)
  const zone = await zoneFor(token, env, existing?.zoneId || input.zoneId)
  const id = existing?.id || `emd_${randomToken(18)}`
  const connected = await connectEmailDomain(token, env.CLOUDFLARE_ACCOUNT_ID, workerName, zone, { id, zoneId: zone.id, domain: normalized })
  const now = nowIso()
  await env.ADMIN_DB.prepare(
    `INSERT INTO email_domains (id, worker_name, zone_id, zone_name, domain, sending_subdomain_id, sending_enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(worker_name, domain) DO UPDATE SET zone_id = excluded.zone_id, zone_name = excluded.zone_name,
       sending_subdomain_id = coalesce(excluded.sending_subdomain_id, email_domains.sending_subdomain_id),
       sending_enabled = excluded.sending_enabled, updated_at = excluded.updated_at`,
  ).bind(connected.id, workerName, zone.id, zone.name, connected.domain, connected.sendingSubdomainId, connected.sendingEnabled ? 1 : 0, now, now).run()
  await audit(env.ADMIN_DB, 'email_domain.connect', workerName, { domain: connected.domain })
  return { id: connected.id, domain: connected.domain, zoneId: zone.id, zoneName: zone.name, sendingEnabled: connected.sendingEnabled }
}

export async function removeEmailDomain(env: AdminEnv, workerName: string, emailDomainId: string) {
  const domain = await env.ADMIN_DB.prepare(
    `SELECT id, zone_id AS zoneId, domain, sending_subdomain_id AS sendingSubdomainId FROM email_domains WHERE id = ? AND worker_name = ?`,
  ).bind(emailDomainId, workerName).first<{ id: string, zoneId: string, domain: string, sendingSubdomainId: string | null }>()
  if (!domain) fail(404, 'Email domain not found')
  const route = await env.ADMIN_DB.prepare('SELECT address FROM mailbox_routes WHERE worker_name = ? AND email_domain_id = ? LIMIT 1')
    .bind(workerName, domain.id).first<{ address: string }>()
  if (route) fail(409, `Delete mailbox ${route.address} before disconnecting this email domain`)
  const token = await cloudflareToken(env)
  await disconnectEmailDomain(token, env.CLOUDFLARE_ACCOUNT_ID, workerName, domain)
  await env.ADMIN_DB.prepare('DELETE FROM email_domains WHERE id = ?').bind(domain.id).run()
  await audit(env.ADMIN_DB, 'email_domain.disconnect', workerName, { domain: domain.domain })
  return { disconnected: true }
}

function mailboxAddress(value: string) {
  const address = value.trim().toLowerCase()
  if (address.length > 90 || !/^[a-z0-9](?:[a-z0-9.!#$%&'*+/=?^_`{|}~-]{0,62}[a-z0-9])?@(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u.test(address)) {
    fail(400, 'Invalid mailbox address')
  }
  return address
}

export async function createMailboxRoute(env: AdminEnv, workerName: string, value: string) {
  const address = mailboxAddress(value)
  const domainName = address.slice(address.lastIndexOf('@') + 1)
  const domain = await env.ADMIN_DB.prepare('SELECT id, zone_id AS zoneId FROM email_domains WHERE worker_name = ? AND domain = ?')
    .bind(workerName, domainName).first<{ id: string, zoneId: string }>()
  if (!domain) fail(409, 'Connect this email domain before creating mailboxes')
  const existing = await env.ADMIN_DB.prepare('SELECT rule_id AS ruleId FROM mailbox_routes WHERE worker_name = ? AND address = ?')
    .bind(workerName, address).first<{ ruleId: string }>()
  if (existing) return { address, ruleId: existing.ruleId }
  const token = await cloudflareToken(env)
  const rule = await ensureMailboxRoute(token, domain.zoneId, workerName, address)
  const now = nowIso()
  await env.ADMIN_DB.prepare(
    'INSERT INTO mailbox_routes (worker_name, email_domain_id, address, rule_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).bind(workerName, domain.id, address, rule.id, now, now).run()
  return { address, ruleId: rule.id }
}

export async function removeMailboxRoute(env: AdminEnv, workerName: string, value: string) {
  const address = mailboxAddress(value)
  const route = await env.ADMIN_DB.prepare(
    `SELECT r.rule_id AS ruleId, d.zone_id AS zoneId FROM mailbox_routes r JOIN email_domains d ON d.id = r.email_domain_id
     WHERE r.worker_name = ? AND r.address = ?`,
  ).bind(workerName, address).first<{ ruleId: string, zoneId: string }>()
  if (!route) return { removed: false }
  const token = await cloudflareToken(env)
  await deleteMailboxRoute(token, route.zoneId, route.ruleId)
  await env.ADMIN_DB.prepare('DELETE FROM mailbox_routes WHERE worker_name = ? AND address = ?').bind(workerName, address).run()
  return { removed: true }
}

/**
 * Rebuild what the Admin tracks for a workspace from Cloudflare itself, so a
 * workspace set up by llll.gg keeps its domains after adoption.
 */
export async function rebuildDomainState(env: AdminEnv, token: string, workerName: string, bindings: Array<{ name?: string, type?: string, text?: string }>) {
  await ensureSchema(env.ADMIN_DB)
  const accountId = env.CLOUDFLARE_ACCOUNT_ID
  const now = nowIso()
  const zones = await listAccountZones(token, accountId)
  const statements: D1PreparedStatement[] = []

  const workerDomains = await cloudflareApi<WorkerDomain[]>(token, `/accounts/${accountId}/workers/domains`)
  const appDomain = workerDomains.find(domain => domain.service === workerName)
  if (appDomain) {
    statements.push(env.ADMIN_DB.prepare(
      `INSERT INTO app_domains (worker_name, zone_id, zone_name, hostname, domain_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(worker_name) DO UPDATE SET zone_id = excluded.zone_id, zone_name = excluded.zone_name, hostname = excluded.hostname,
         domain_id = excluded.domain_id, updated_at = excluded.updated_at`,
    ).bind(workerName, appDomain.zone_id, appDomain.zone_name, appDomain.hostname.toLowerCase(), appDomain.id, now, now))
  }

  const text = (name: string) => bindings.find(binding => binding.name === name && binding.type === 'plain_text')?.text?.trim() || ''
  let emailDomains: Array<{ id: string, zoneId: string, domain: string }> = []
  try {
    const parsed = JSON.parse(text('LLLL_EMAIL_DOMAINS') || '[]') as unknown
    if (Array.isArray(parsed)) emailDomains = parsed.filter((item): item is { id: string, zoneId: string, domain: string } => Boolean(item?.id && item?.zoneId && item?.domain))
  }
  catch { /* legacy single-domain bindings below */ }
  if (!emailDomains.length && text('MAIL_DOMAIN') && text('MAIL_ZONE_ID')) {
    emailDomains = [{ id: 'main', zoneId: text('MAIL_ZONE_ID'), domain: text('MAIL_DOMAIN') }]
  }

  for (const domain of emailDomains) {
    const zone = zones.find(candidate => candidate.id === domain.zoneId)
    if (!zone) continue
    const senders = await cloudflareApi<SendingSubdomain[]>(token, `/zones/${zone.id}/email/sending/subdomains`).catch(() => [])
    const sending = senders.find(sender => sender.name.toLowerCase() === domain.domain.toLowerCase())
    statements.push(env.ADMIN_DB.prepare(
      `INSERT INTO email_domains (id, worker_name, zone_id, zone_name, domain, sending_subdomain_id, sending_enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)
       ON CONFLICT(worker_name, domain) DO UPDATE SET zone_id = excluded.zone_id, zone_name = excluded.zone_name,
         sending_enabled = excluded.sending_enabled, updated_at = excluded.updated_at`,
    ).bind(domain.id, workerName, zone.id, zone.name, domain.domain.toLowerCase(), sending?.enabled ? 1 : 0, now, now))

    const rules = await cloudflareApi<RoutingRule[]>(token, `/zones/${zone.id}/email/routing/rules?per_page=100`).catch(() => [])
    for (const rule of rules) {
      const address = rule.matchers?.find(matcher => matcher.type === 'literal' && matcher.field === 'to')?.value?.toLowerCase()
      const target = rule.actions?.find(action => action.type === 'worker')?.value?.[0]
      if (!address || target !== workerName || !address.endsWith(`@${domain.domain.toLowerCase()}`)) continue
      statements.push(env.ADMIN_DB.prepare(
        `INSERT INTO mailbox_routes (worker_name, email_domain_id, address, rule_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(worker_name, address) DO UPDATE SET rule_id = excluded.rule_id, updated_at = excluded.updated_at`,
      ).bind(workerName, domain.id, address, rule.id, now, now))
    }
  }
  if (statements.length) await env.ADMIN_DB.batch(statements)
}

/** Remove everything the Admin connected for a workspace before the workspace is deleted. */
export async function cleanupDomains(env: AdminEnv, token: string, workerName: string): Promise<string[]> {
  const deleted: string[] = []
  const routes = await env.ADMIN_DB.prepare(
    `SELECT r.address, r.rule_id AS ruleId, d.zone_id AS zoneId FROM mailbox_routes r JOIN email_domains d ON d.id = r.email_domain_id
     WHERE r.worker_name = ?`,
  ).bind(workerName).all<{ address: string, ruleId: string, zoneId: string }>()
  for (const route of routes.results || []) {
    await deleteMailboxRoute(token, route.zoneId, route.ruleId)
    deleted.push(`email route ${route.address}`)
  }
  const domains = await env.ADMIN_DB.prepare(
    `SELECT id, zone_id AS zoneId, domain, sending_subdomain_id AS sendingSubdomainId FROM email_domains WHERE worker_name = ?`,
  ).bind(workerName).all<{ id: string, zoneId: string, domain: string, sendingSubdomainId: string | null }>()
  for (const domain of domains.results || []) {
    await disconnectEmailDomain(token, env.CLOUDFLARE_ACCOUNT_ID, workerName, domain)
    deleted.push(`email domain ${domain.domain}`)
  }
  const app = await env.ADMIN_DB.prepare('SELECT domain_id AS domainId, hostname FROM app_domains WHERE worker_name = ?')
    .bind(workerName).first<{ domainId: string, hostname: string }>()
  if (app) {
    await disconnectAppDomain(token, env.CLOUDFLARE_ACCOUNT_ID, workerName, app.domainId)
    deleted.push(`custom domain ${app.hostname}`)
  }
  await env.ADMIN_DB.batch([
    env.ADMIN_DB.prepare('DELETE FROM mailbox_routes WHERE worker_name = ?').bind(workerName),
    env.ADMIN_DB.prepare('DELETE FROM email_domains WHERE worker_name = ?').bind(workerName),
    env.ADMIN_DB.prepare('DELETE FROM app_domains WHERE worker_name = ?').bind(workerName),
    env.ADMIN_DB.prepare('DELETE FROM live_apps WHERE worker_name = ?').bind(workerName),
  ])
  return deleted
}
