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
import { serverDomainLaunchUrl } from './server-updates'

function cloudflareManaged(env: L4Env): boolean {
  return Boolean(env.LLLL_ACCOUNT_ID?.trim() && env.LLLL_WORKER_NAME?.trim())
    && env.LLLL_RUNTIME?.trim().toLowerCase() !== 'celld'
}

/** Cloudflare Servers can request a domain change through the official installer. */
export async function readManagedServerDomains(env: L4Env, fallbackOrigin?: string): Promise<ServerDomainSettingsDTO> {
  const managed = cloudflareManaged(env)
  const origins = await readServerOrigins(env, fallbackOrigin)
  return {
    managed,
    source: managed ? 'cloudflare' : 'operator',
    primary: origins.find(item => item.primary)?.origin || null,
    origins,
    pending: managed ? await listServerDomainRequests(env) : [],
    zones: [],
    appDomain: null,
    emailDomains: [],
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
  if (!cloudflareManaged(env)) operatorRequired()
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
  const launchUrl = serverDomainLaunchUrl(env, request, token, {
    makePrimary: input.makePrimary,
    fallbackOrigin,
    serverId: await getServerId(env.DB),
  })
  if (!launchUrl) fail(409, 'domain_control_unavailable', 'Cloudflare domain control is not configured for this Server')
  return { request, launchUrl }
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

export async function connectManagedEmailDomain(_env: L4Env, _input: { zoneId: string, domain: string }): Promise<{ id: string, domain: string, zoneId: string, zoneName: string, sendingEnabled?: boolean }> { return operatorRequired() }
export async function disconnectManagedEmailDomain(_env: L4Env, _id: string): Promise<{ disconnected: boolean }> { return operatorRequired() }
