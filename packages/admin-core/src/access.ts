import type Cloudflare from 'cloudflare'
import type { DeployRequest } from './types.js'
import { createError } from './errors.js'

type AccessApplication = {
  id?: string
  aud?: string
  domain?: string
  name?: string
  type?: string
  destinations?: Array<{ type?: string, worker_id?: string, uri?: string }>
}

function statusCode(error: unknown) {
  if (!error || typeof error !== 'object') return 0
  const value = error as { status?: unknown, statusCode?: unknown }
  return Number(value.statusCode || value.status || 0)
}

export async function ensureWorkersHostname(client: Cloudflare, accountId: string, workerName: string) {
  try {
    const current = await client.workers.subdomains.get({ account_id: accountId })
    return `${workerName}.${current.subdomain}.workers.dev`
  }
  catch (error) {
    if (statusCode(error) !== 404) throw error
  }

  const prefix = `llll-${accountId.slice(0, 8)}`
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const subdomain = attempt ? `${prefix}-${crypto.randomUUID().slice(0, 6)}` : prefix
    try {
      const created = await client.workers.subdomains.update({ account_id: accountId, subdomain })
      return `${workerName}.${created.subdomain}.workers.dev`
    }
    catch (error) {
      if (statusCode(error) !== 409) throw error
    }
  }
  throw createError({ statusCode: 409, statusMessage: 'Could not reserve a workers.dev subdomain for this account' })
}

async function ensureOrganization(client: Cloudflare, accountId: string) {
  try {
    const organization = await client.zeroTrust.organizations.list({ account_id: accountId })
    if (organization.auth_domain) return organization.auth_domain
  }
  catch (error) {
    if (statusCode(error) !== 404) throw error
  }

  const prefix = `llll-${accountId.slice(0, 8)}`
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const slug = attempt ? `${prefix}-${crypto.randomUUID().slice(0, 6)}` : prefix
    try {
      const organization = await client.zeroTrust.organizations.create({
        account_id: accountId,
        auth_domain: `${slug}.cloudflareaccess.com`,
        name: 'L4',
      })
      if (organization.auth_domain) return organization.auth_domain
    }
    catch (error) {
      if (statusCode(error) !== 409) throw error
    }
  }
  throw createError({ statusCode: 409, statusMessage: 'Could not create a Cloudflare Zero Trust organization' })
}

async function ensureOtpProvider(client: Cloudflare, accountId: string) {
  for await (const provider of client.zeroTrust.identityProviders.list({ account_id: accountId })) {
    if (provider.type === 'onetimepin' && provider.id) return provider.id
  }
  const provider = await client.zeroTrust.identityProviders.create({
    account_id: accountId,
    config: {},
    name: 'One-time PIN',
    type: 'onetimepin',
  })
  if (!provider.id) throw createError({ statusCode: 502, statusMessage: 'Cloudflare did not return the Access login method ID' })
  return provider.id
}

async function accessApplications(client: Cloudflare, accountId: string) {
  const applications: AccessApplication[] = []
  for await (const application of client.zeroTrust.access.applications.list({ account_id: accountId })) {
    applications.push(application as AccessApplication)
  }
  return applications
}

async function putApplication(
  client: Cloudflare,
  accountId: string,
  existing: AccessApplication | undefined,
  body: Record<string, unknown>,
) {
  const api = client.zeroTrust.access.applications
  const result = existing?.id
    ? await api.update(existing.id, { account_id: accountId, ...body } as never)
    : await api.create({ account_id: accountId, ...body } as never)
  return result as AccessApplication
}

async function provisionCloudflareAccess(client: Cloudflare, request: DeployRequest, hostname: string, workerId?: string) {
  const authDomain = await ensureOrganization(client, request.accountId)
  const [otpProviderId, applications] = await Promise.all([
    ensureOtpProvider(client, request.accountId),
    accessApplications(client, request.accountId),
  ])
  const appName = `L4 — ${request.workerName}`
  const healthName = `${appName} health`
  const deletionName = `${appName} deletion`
  const mainExisting = applications.find(app => app.name === appName && (
    !request.customDomainEnabled || app.domain?.toLowerCase() === hostname
  ))
  const healthDomain = `${hostname}/api/setup/health`
  const healthExisting = applications.find(app => app.domain?.toLowerCase() === healthDomain && app.name === healthName)
  const deletionDomain = `${hostname}/api/workspaces/main/deletion/prepare`
  const deletionExisting = applications.find(app => app.domain?.toLowerCase() === deletionDomain && app.name === deletionName)
  const conflict = applications.find(app => (
    (app.domain?.toLowerCase() === hostname || app.domain?.toLowerCase() === healthDomain || app.domain?.toLowerCase() === deletionDomain)
    && app.name !== appName
    && app.name !== healthName
    && app.name !== deletionName
  ))
  if (conflict) {
    throw createError({ statusCode: 409, statusMessage: `${conflict.domain} is already protected by another Cloudflare Access application` })
  }

  const emails = [...new Set([request.adminEmail, ...request.allowedEmails].map(email => email.trim().toLowerCase()))]
  const application = await putApplication(client, request.accountId, mainExisting, {
    ...(request.customDomainEnabled ? { domain: hostname } : {}),
    type: 'self_hosted',
    name: appName,
    destinations: request.customDomainEnabled
      ? [{ type: 'public', uri: hostname }]
      : [{ type: 'worker', worker_id: workerId }],
    allowed_idps: [otpProviderId],
    auto_redirect_to_identity: true,
    app_launcher_visible: true,
    session_duration: '24h',
    policies: [{
      name: 'L4 members',
      decision: 'allow',
      include: emails.map(email => ({ email: { email } })),
      require: [{ login_method: { id: otpProviderId } }],
    }],
  })
  const health = await putApplication(client, request.accountId, healthExisting, {
    domain: healthDomain,
    type: 'self_hosted',
    name: healthName,
    destinations: [{ type: 'public', uri: healthDomain }],
    app_launcher_visible: false,
    policies: [{ name: 'Installer health check', decision: 'bypass', include: [{ everyone: {} }] }],
  })
  const deletion = await putApplication(client, request.accountId, deletionExisting, {
    domain: deletionDomain,
    type: 'self_hosted',
    name: deletionName,
    destinations: [{ type: 'public', uri: deletionDomain }],
    app_launcher_visible: false,
    policies: [{ name: 'Authorized installer deletion', decision: 'bypass', include: [{ everyone: {} }] }],
  })
  if (!application.id || !application.aud || !health.id || !deletion.id) {
    throw createError({ statusCode: 502, statusMessage: 'Cloudflare did not return the Access application details' })
  }
  return {
    issuer: `https://${authDomain}`,
    audience: application.aud,
    applicationId: application.id,
    healthApplicationId: health.id,
    deletionApplicationId: deletion.id,
  }
}

export async function ensureCloudflareAccess(client: Cloudflare, request: DeployRequest, hostname: string, workerId?: string) {
  if (!request.customDomainEnabled && !workerId) {
    throw createError({ statusCode: 502, statusMessage: 'Cloudflare did not return the Worker ID required by Access' })
  }
  try {
    return await provisionCloudflareAccess(client, request, hostname, workerId)
  }
  catch (error) {
    if (statusCode(error) === 403) {
      throw createError({
        statusCode: 403,
        statusMessage: 'Cloudflare Access permission was not granted. Sign out, reconnect Cloudflare, and try again.',
      })
    }
    throw error
  }
}
