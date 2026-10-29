import type { L4Env } from '../../workers/env'
import type { ServerDomainSettingsDTO } from '../../shared/releases'
import { normalizeHostname } from '../../shared/server-origins'
import { getServerId } from '../../shared/server-id'
import { fail } from './cf'
import {
  createServerDomainRequest,
  listServerDomainRequests,
  readServerOrigins,
  type ServerDomainRequestAction,
} from './server-origins'
import { serverDeployment, serverDomainLaunchUrl } from './server-updates'
import { cloudflareAccessStatus, cloudflareAccessToken } from './cloudflare-account-access'
import { connectAppDomain, connectEmailDomain, disconnectAppDomain, disconnectEmailDomain, findAppDomain, findAppDomainZone, setPrimaryAppDomain } from '../../packages/deployment-core/src/domains'
import { listAccountZones } from '../../packages/deployment-core/src/servers'
import { readServerMailDomains } from './server-mail'
import { readServerSetting, writeServerSetting } from '../../shared/server-settings'

/** Cloudflare access kept on this Server, so changes run here instead of through the installer. */
async function keptAccess(env: L4Env) {
  if (!(await cloudflareAccessStatus(env)).connected) return null
  const deployment = await serverDeployment(env)
  if (!deployment) return null
  const { token, accountId } = await cloudflareAccessToken(env)
  return { token, accountId, workerName: deployment.workerName }
}

/** A Server manages its own Cloudflare domains only through the official installer grant. */
async function cloudflareManaged(env: L4Env): Promise<boolean> {
  if (env.LLLL_RUNTIME?.trim().toLowerCase() === 'celld') return false
  return Boolean(env.ACCOUNT_ID?.trim() || env.LLLL_ACCOUNT_ID?.trim())
}

/** Cloudflare Servers can request a domain change through the official installer. */
export async function readManagedServerDomains(env: L4Env, fallbackOrigin?: string): Promise<ServerDomainSettingsDTO> {
  const managed = await cloudflareManaged(env)
  const origins = await readServerOrigins(env, fallbackOrigin)
  const access = managed ? await keptAccess(env).catch(() => null) : null
  const zones = access ? (await listAccountZones(access.token, access.accountId).catch(() => [])).filter(zone => zone.status === 'active') : []
  return {
    managed,
    source: managed ? 'cloudflare' : 'operator',
    direct: Boolean(access),
    primary: origins.find(item => item.primary)?.origin || null,
    origins,
    pending: managed ? await listServerDomainRequests(env) : [],
    zones: zones.map(zone => ({ id: zone.id, name: zone.name })),
    appDomain: null,
    emailDomains: access ? (await readServerMailDomains(env)).map(domain => ({ ...domain, zoneName: zones.find(zone => zone.id === domain.zoneId)?.name ?? '' })) : [],
  }
}

export function failServerControl(error: unknown): never {
  const candidate = error as { statusCode?: unknown, message?: unknown }
  const status = Number(candidate?.statusCode)
  fail(status >= 400 && status < 500 ? status : 502, 'server_infrastructure', typeof candidate?.message === 'string' ? candidate.message : 'The deployment operator must configure this server')
}

function operatorRequired(): never {
  fail(409, 'operator_managed_domain', 'Configure domain routing through the server operator or your deployment configuration')
}

async function requestDomainChange(
  env: L4Env,
  fallbackOrigin: string | undefined,
  input: { action: ServerDomainRequestAction, hostname: string, makePrimary?: boolean },
) {
  if (!await cloudflareManaged(env)) operatorRequired()
  let hostname: string
  try {
    hostname = normalizeHostname(input.hostname)
  }
  catch (error) {
    fail(400, 'invalid_hostname', error instanceof Error ? error.message : 'Enter a valid hostname')
  }
  if (hostname.endsWith('.workers.dev')) fail(400, 'custom_domain_required', input.action === 'add' ? 'Choose a hostname in a Cloudflare zone you control' : 'The workers.dev address stays enabled and cannot be changed here')
  const origins = await readServerOrigins(env, fallbackOrigin)
  const existing = origins.find(item => item.hostname === hostname)
  if (input.action === 'add') {
    if (existing) fail(409, 'domain_exists', 'This address is already connected')
  }
  else if (!existing) {
    fail(404, 'domain_missing', 'This address is not connected')
  }
  if (input.action === 'remove' && existing?.primary) {
    fail(409, 'primary_domain', 'Choose another primary address before removing this one')
  }
  if (input.action === 'primary' && existing?.primary) {
    fail(409, 'primary_domain', 'This is already the primary address')
  }
  const { request, token } = await createServerDomainRequest(env, { action: input.action, hostname })
  const access = await keptAccess(env)
  if (access) return { request: await applyDomainHere(env, access, request.id, { ...input, hostname }, fallbackOrigin), applied: true as const }
  const launchUrl = await serverDomainLaunchUrl(env, request, token, {
    makePrimary: input.makePrimary,
    fallbackOrigin,
    serverId: await getServerId(env.DB),
  })
  if (!launchUrl) fail(409, 'domain_control_unavailable', 'Cloudflare domain control is not configured for this Server')
  return { request, launchUrl }
}

const settle = (env: L4Env, id: string, status: 'complete' | 'failed', error: string | null) =>
  env.DB.prepare('UPDATE server_domain_requests SET status = ?, error = ?, updated_at = ? WHERE id = ?').bind(status, error, new Date().toISOString(), id).run()

/** The same change the installer applies, made with this Server's own access and database. */
async function applyDomainHere(
  env: L4Env,
  access: { token: string, accountId: string, workerName: string },
  requestId: string,
  input: { action: ServerDomainRequestAction, hostname: string, makePrimary?: boolean },
  fallbackOrigin?: string,
) {
  const { token, accountId, workerName } = access
  const origin = `https://${input.hostname}`
  const now = () => new Date().toISOString()
  try {
    if (input.action === 'add') {
      const zone = await findAppDomainZone(token, accountId, input.hostname)
      await connectAppDomain(token, accountId, workerName, zone, input.hostname)
      await env.DB.prepare('INSERT OR IGNORE INTO server_domains(origin, hostname, is_primary, created_at) VALUES (?, ?, 0, ?)').bind(origin, input.hostname, now()).run()
      if (input.makePrimary) {
        await setPrimaryAppDomain(token, accountId, workerName, zone, input.hostname)
        await env.DB.prepare('UPDATE server_domains SET is_primary = CASE WHEN origin = ? THEN 1 ELSE 0 END').bind(origin).run()
      }
    }
    else {
      const existing = (await readServerOrigins(env, fallbackOrigin)).find(item => item.hostname === input.hostname)
      if (!existing) fail(404, 'domain_missing', 'This address is not connected')
      const attached = await findAppDomain(token, accountId, workerName, input.hostname)
      if (input.action === 'remove') {
        if (attached) await disconnectAppDomain(token, accountId, workerName, attached.id)
        await env.DB.prepare('DELETE FROM server_domains WHERE origin = ? AND is_primary = 0').bind(existing.origin).run()
      }
      else {
        if (!attached) fail(409, 'domain_detached', 'This address is not attached in Cloudflare. Remove it, then add it again.')
        await setPrimaryAppDomain(token, accountId, workerName, await findAppDomainZone(token, accountId, input.hostname), input.hostname)
        await env.DB.prepare('UPDATE server_domains SET is_primary = CASE WHEN origin = ? THEN 1 ELSE 0 END').bind(existing.origin).run()
      }
    }
    await settle(env, requestId, 'complete', null)
  }
  catch (error) {
    const candidate = error as { statusMessage?: string, message?: string, data?: { error?: { message?: string } } }
    await settle(env, requestId, 'failed', candidate?.data?.error?.message || candidate?.statusMessage || candidate?.message || 'The domain change did not complete')
    throw error
  }
  return (await listServerDomainRequests(env)).find(item => item.id === requestId) ?? null
}

export async function connectManagedAppDomain(
  env: L4Env,
  input: { hostname: string, makePrimary?: boolean },
  fallbackOrigin?: string,
) {
  return requestDomainChange(env, fallbackOrigin, { action: 'add', ...input })
}

export async function disconnectManagedAppDomain(env: L4Env, hostname: string, fallbackOrigin?: string) {
  return requestDomainChange(env, fallbackOrigin, { action: 'remove', hostname })
}

export async function makeManagedAppDomainPrimary(env: L4Env, hostname: string, fallbackOrigin?: string) {
  return requestDomainChange(env, fallbackOrigin, { action: 'primary', hostname })
}

/** Mail domains use this Server's kept Cloudflare access; without it they stay operator-managed. */
export async function connectManagedEmailDomain(env: L4Env, input: { zoneId: string, domain: string }): Promise<{ id: string, domain: string, zoneId: string, zoneName: string, sendingEnabled?: boolean }> {
  const access = await keptAccess(env)
  if (!access) operatorRequired()
  const zone = (await listAccountZones(access.token, access.accountId)).find(item => item.id === input.zoneId)
  if (!zone) fail(400, 'zone_missing', 'Choose an active Cloudflare zone in this account')
  const known = await readServerMailDomains(env)
  const reuse = known.find(item => item.domain === input.domain.trim().toLowerCase())
  const connected = await connectEmailDomain(access.token, access.accountId, access.workerName, zone, { id: reuse?.id ?? crypto.randomUUID(), zoneId: zone.id, domain: input.domain })
  // D1 is authoritative for mail once onboarded; the Worker binding alone is only read on first start.
  const appHostname = await readServerSetting(env.DB, 'mail_app_hostname') || new URL((await readServerOrigins(env)).find(item => item.primary)?.origin || env.PUBLIC_ORIGIN || 'https://localhost').hostname
  await writeServerSetting(env.DB, 'mail_app_hostname', appHostname)
  await writeServerSetting(env.DB, 'mail_domains', JSON.stringify([...known.filter(item => item.domain !== connected.domain), { id: connected.id, zoneId: zone.id, domain: connected.domain }]))
  const now = new Date().toISOString()
  await env.DB.prepare(`INSERT INTO email_domains (id, zone_id, domain, app_hostname, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET zone_id = excluded.zone_id, domain = excluded.domain, app_hostname = excluded.app_hostname, updated_at = excluded.updated_at`)
    .bind(connected.id, zone.id, connected.domain, appHostname, now, now).run()
  return { id: connected.id, domain: connected.domain, zoneId: zone.id, zoneName: zone.name, sendingEnabled: connected.sendingEnabled }
}
export async function disconnectManagedEmailDomain(env: L4Env, id: string): Promise<{ disconnected: boolean }> {
  const access = await keptAccess(env)
  if (!access) operatorRequired()
  const known = await readServerMailDomains(env)
  const domain = known.find(item => item.id === id)
  if (!domain) fail(404, 'email_domain_missing', 'This mail domain is not connected')
  await disconnectEmailDomain(access.token, access.accountId, access.workerName, domain)
  await writeServerSetting(env.DB, 'mail_domains', JSON.stringify(known.filter(item => item.id !== id)))
  // Mailboxes and their history stay; a domain with mailboxes is kept until they are removed.
  await env.DB.prepare('DELETE FROM email_domains WHERE id = ? AND id NOT IN (SELECT DISTINCT domain_id FROM email_mailboxes)').bind(id).run()
  return { disconnected: true }
}
