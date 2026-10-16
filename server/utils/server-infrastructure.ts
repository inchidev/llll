import type { L4Env } from '../../workers/env'
import type { InstallationDomainSettingsDTO } from '../../shared/releases'
import { fail } from './cf'

/** Domain routing belongs to the deployment operator. No public control-plane request is made. */
export async function readManagedInstallationDomains(_env: L4Env): Promise<InstallationDomainSettingsDTO> {
  return { managed: false, zones: [], appDomain: null, emailDomains: [] }
}
export function failInstallationControl(error: unknown): never {
  const candidate = error as { statusCode?: unknown, message?: unknown }
  const status = Number(candidate?.statusCode)
  fail(status >= 400 && status < 500 ? status : 502, 'server_infrastructure', typeof candidate?.message === 'string' ? candidate.message : 'The deployment operator must configure this server')
}
function operatorRequired(): never {
  fail(409, 'operator_managed_domain', 'Configure domain routing through the installation operator or your deployment configuration')
}
export async function connectManagedAppDomain(_env: L4Env, _input: { zoneId: string, hostname: string }): Promise<{ hostname: string }> { return operatorRequired() }
export async function disconnectManagedAppDomain(_env: L4Env): Promise<{ hostname: string }> { return operatorRequired() }
export async function connectManagedEmailDomain(_env: L4Env, _input: { zoneId: string, domain: string }): Promise<{ id: string, domain: string, zoneId: string, zoneName: string, sendingEnabled?: boolean }> { return operatorRequired() }
export async function disconnectManagedEmailDomain(_env: L4Env, _id: string): Promise<{ disconnected: boolean }> { return operatorRequired() }
