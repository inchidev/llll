import { cloudflareClient } from './cloudflare-client.js'
import { deployL4, deployL4Update } from './deploy.js'
import { createError } from './errors.js'
import { loadL4Release, releaseManifestUrl } from './release.js'
import { parseBaseInstallRequest, parseDeployRequest } from './request.js'
import type { DeployProgressReporter, DeployProgressStep, DeployResponse } from './types.js'

export type InstallL4Options = {
  manifestUrl?: string
  report?: DeployProgressReporter
  /** Let the caller verify the newly deployed public endpoint, including browser reachability. */
  verify?: boolean
  /** Keep the caller's one-time owner claim instead of generating a new one. */
  setupToken?: string
}

/** Complete install/update operation. Credential acquisition and UI stay in the caller. */
export async function installL4(
  accessToken: string,
  value: unknown,
  options: InstallL4Options = {},
): Promise<DeployResponse> {
  if (!accessToken.trim()) throw createError({ statusCode: 401, statusMessage: 'Cloudflare API token is missing' })
  const request = parseDeployRequest(value)
  const progress = async (step: DeployProgressStep, state: 'active' | 'complete', detail?: string) => {
    await options.report?.({ type: 'progress', step, state, detail })
  }

  await progress('account', 'active')
  const client = cloudflareClient(accessToken)
  const account = await client.accounts.get({ account_id: request.accountId })
  if (account.id !== request.accountId) throw createError({ statusCode: 403, statusMessage: 'Cloudflare account is unavailable' })
  if (request.customDomainEnabled || request.mailEnabled) {
    const zone = await client.zones.get({ zone_id: request.zoneId })
    if (zone.id !== request.zoneId || zone.name !== request.zoneName || zone.account?.id !== request.accountId) {
      throw createError({ statusCode: 403, statusMessage: 'Cloudflare domain is unavailable in this account' })
    }
  }
  await progress('account', 'complete', account.name || undefined)

  await progress('release', 'active')
  const manifestUrl = options.manifestUrl || releaseManifestUrl(request.targetVersion)
  const release = await loadL4Release(manifestUrl)
  if (request.authMode === 'access' && !release.manifest.capabilities?.includes('cloudflare-access-auth')) {
    throw createError({ statusCode: 409, statusMessage: 'This L4 release does not support Cloudflare Access authentication' })
  }
  if (request.targetVersion && release.manifest.version !== request.targetVersion.replace(/^v/u, '')) {
    throw createError({ statusCode: 502, statusMessage: 'L4 release manifest version does not match the requested update' })
  }
  await progress('release', 'complete', `L4 ${release.manifest.version}`)

  const deployed = await deployL4(
    client,
    accessToken,
    request,
    release,
    options.report,
    { verify: options.verify, setupToken: options.setupToken },
  )
  return deployed
}

export async function installBaseL4(
  accessToken: string,
  value: unknown,
  options: InstallL4Options = {},
): Promise<DeployResponse> {
  const request = parseBaseInstallRequest(value)
  return installL4(accessToken, {
    ...request,
    customDomainEnabled: false,
    zoneId: '',
    zoneName: '',
    appSubdomain: request.workerName,
    mailEnabled: false,
    mailSubdomain: '',
    mailLocalPart: '',
  }, options)
}

export async function updateL4(
  accessToken: string,
  value: { accountId?: unknown, workerName?: unknown, targetVersion?: unknown },
  options: { manifestUrl?: string, verify?: boolean } = {},
): Promise<DeployResponse> {
  if (!accessToken.trim()) throw createError({ statusCode: 401, statusMessage: 'Cloudflare API token is missing' })
  const accountId = String(value?.accountId || '').trim()
  const workerName = String(value?.workerName || '').trim().toLowerCase()
  const targetVersion = String(value?.targetVersion || '').trim()
  if (!/^[0-9a-f]{32}$/u.test(accountId)) throw createError({ statusCode: 400, statusMessage: 'Cloudflare account is invalid' })
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(workerName)) throw createError({ statusCode: 400, statusMessage: 'Worker name is invalid' })
  if (!/^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/u.test(targetVersion)) throw createError({ statusCode: 400, statusMessage: 'L4 release version is invalid' })
  const release = await loadL4Release(options.manifestUrl || releaseManifestUrl(targetVersion))
  if (release.manifest.version !== targetVersion.replace(/^v/u, '')) {
    throw createError({ statusCode: 502, statusMessage: 'L4 release manifest version does not match the requested update' })
  }
  return deployL4Update(accessToken, accountId, workerName, release, { verify: options.verify })
}
