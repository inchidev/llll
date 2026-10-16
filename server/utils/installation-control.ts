import type { L4Env } from '../../workers/env'
import type { InstallationDomainSettingsDTO } from '../../shared/releases'
import { fail } from './cf'
import { llllAdmin } from '../../workers/llll-admin'

const DEFAULT_CONTROL_ENDPOINT = 'https://llll.gg/api/installation-control'

function controlConfig(env: L4Env) {
  const installationId = env.LLLL_CONTROL_ID?.trim()
  const token = env.LLLL_CONTROL_TOKEN?.trim()
  if (!installationId || !token) return null
  return {
    installationId,
    token,
    endpoint: (env.LLLL_CONTROL_ENDPOINT?.trim() || DEFAULT_CONTROL_ENDPOINT).replace(/\/$/u, ''),
  }
}

async function controlRequest<T>(
  env: L4Env,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: Record<string, unknown>,
): Promise<T | null> {
  const config = controlConfig(env)
  if (!config) return null
  const response = await fetch(`${config.endpoint}/installations/${encodeURIComponent(config.installationId)}/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${config.token}`,
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    cache: 'no-store',
    redirect: 'manual',
  })
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { statusMessage?: string, message?: string } | null
    const error = new Error(payload?.statusMessage || payload?.message || `L4 Control Plane rejected the request (${response.status})`)
    Object.assign(error, { statusCode: response.status })
    throw error
  }
  return await response.json() as T
}

export function failInstallationControl(error: unknown): never {
  const candidate = error as { statusCode?: unknown, message?: unknown }
  const status = Number(candidate?.statusCode)
  fail(status >= 400 && status < 500 ? status : 502, 'control_plane', typeof candidate?.message === 'string' ? candidate.message : 'L4 could not change this Installation')
}

export async function readManagedInstallationDomains(env: L4Env): Promise<InstallationDomainSettingsDTO> {
  const admin = llllAdmin(env)
  if (admin) {
    const state = await admin.domains()
    return { managed: true, zones: state.zones, appDomain: state.appDomain, emailDomains: state.emailDomains }
  }
  const state = await controlRequest<Omit<InstallationDomainSettingsDTO, 'managed'>>(env, 'GET', 'domains')
  return state
    ? { managed: true, zones: state.zones, appDomain: state.appDomain, emailDomains: state.emailDomains }
    : { managed: false, zones: [], appDomain: null, emailDomains: [] }
}

export async function connectManagedAppDomain(env: L4Env, input: { zoneId: string, hostname: string }) {
  const admin = llllAdmin(env)
  if (admin) return admin.connectAppDomain(input)
  return controlRequest<{ hostname: string }>(env, 'PUT', 'app-domain', input)
}

export async function disconnectManagedAppDomain(env: L4Env) {
  const admin = llllAdmin(env)
  if (admin) return admin.disconnectAppDomain()
  return controlRequest<{ hostname: string }>(env, 'DELETE', 'app-domain')
}

export async function connectManagedEmailDomain(env: L4Env, input: { zoneId: string, domain: string }) {
  const admin = llllAdmin(env)
  if (admin) return admin.connectEmailDomain(input)
  return controlRequest<{ id: string, domain: string, zoneId: string, zoneName: string, sendingEnabled?: boolean }>(env, 'POST', 'email-domains', input)
}

export async function disconnectManagedEmailDomain(env: L4Env, emailDomainId: string) {
  const admin = llllAdmin(env)
  if (admin) return admin.disconnectEmailDomain(emailDomainId)
  return controlRequest<{ disconnected: boolean }>(env, 'DELETE', `email-domains/${encodeURIComponent(emailDomainId)}`)
}

export function createManagedMailboxRoute(env: L4Env, address: string) {
  const admin = llllAdmin(env)
  if (admin) return admin.createMailboxRoute(address)
  return controlRequest(env, 'POST', 'mailbox-routes', { address })
}

export function deleteManagedMailboxRoute(env: L4Env, address: string) {
  const admin = llllAdmin(env)
  if (admin) return admin.deleteMailboxRoute(address)
  return controlRequest(env, 'DELETE', 'mailbox-routes', { address })
}
