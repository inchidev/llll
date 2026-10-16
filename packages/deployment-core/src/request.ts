import { installerError } from './errors.js'
import type { BaseInstallRequest, DeployRequest } from './types.js'

export function parseDeployRequest(value: unknown): DeployRequest {
  const body = value as Partial<DeployRequest> | null
  if (!body || typeof body !== 'object') installerError(400, 'Invalid deploy request')
  const accountId = String(body.accountId || '').trim()
  const workerName = String(body.workerName || '').trim().toLowerCase()
  const appName = String(body.appName || '').trim()
  const authMode = body.authMode === undefined ? 'builtin' : body.authMode
  if (authMode !== 'builtin' && authMode !== 'access') installerError(400, 'Select a sign-in mode')
  const customDomainEnabled = body.customDomainEnabled === true
  const zoneId = String(body.zoneId || '').trim()
  const zoneName = String(body.zoneName || '').trim().toLowerCase()
  const appSubdomain = String(body.appSubdomain || '').trim().toLowerCase()
  const mailEnabled = body.mailEnabled === true
  const mailSubdomain = String(body.mailSubdomain || '').trim().toLowerCase()
  const mailLocalPart = String(body.mailLocalPart || '').trim().toLowerCase()
  if (!/^[0-9a-f]{32}$/u.test(accountId)) installerError(400, 'Select a Cloudflare account')
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(workerName)) installerError(400, 'Worker name must use lowercase letters, numbers, and hyphens')
  if (!appName || appName.length > 80) installerError(400, 'App name must be 1–80 characters')
  const zoneRequired = customDomainEnabled || mailEnabled
  if (zoneRequired && !/^[0-9a-f]{32}$/u.test(zoneId)) installerError(400, 'Select a Cloudflare domain')
  if (zoneRequired && !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u.test(zoneName)) installerError(400, 'Invalid Cloudflare domain')
  if (customDomainEnabled && !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(appSubdomain)) installerError(400, 'App subdomain must use lowercase letters, numbers, and hyphens')
  if (mailEnabled && !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(mailSubdomain)) installerError(400, 'Email subdomain must use lowercase letters, numbers, and hyphens')
  if (mailEnabled && !/^[a-z0-9](?:[a-z0-9.!#$%&'*+/=?^_`{|}~-]{0,62}[a-z0-9])?$/u.test(mailLocalPart)) installerError(400, 'Enter a valid default mailbox')
  const registrationMode = body.registrationMode === undefined ? 'invite_only' : body.registrationMode
  if (authMode === 'builtin' && registrationMode !== 'invite_only' && registrationMode !== 'open') installerError(400, 'Select a registration mode')
  const adminEmail = String(body.adminEmail || '').trim().toLowerCase().slice(0, 254)
  if (adminEmail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/u.test(adminEmail)) installerError(400, 'Enter a valid owner email')
  const allowedEmails = authMode === 'access' && Array.isArray(body.allowedEmails)
    ? [...new Set(body.allowedEmails.map(item => String(item).trim().toLowerCase()).filter(Boolean))]
    : []
  if (allowedEmails.length > 20 || allowedEmails.some(email => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/u.test(email))) installerError(400, 'Enter at most 20 valid Access member emails')
  const targetVersion = typeof body.targetVersion === 'string' && /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/u.test(body.targetVersion)
    ? body.targetVersion
    : undefined
  if (body.targetVersion && !targetVersion) installerError(400, 'Invalid L4 release version')
  const backupBucketName = typeof body.backupBucketName === 'string' ? body.backupBucketName.trim() : ''
  if (backupBucketName && !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(backupBucketName)) installerError(400, 'Backup bucket name is invalid')
  return {
    ...(backupBucketName ? { backupBucketName } : {}),
    accountId,
    workerName,
    appName,
    authMode,
    registrationMode: authMode === 'access' ? 'open' : registrationMode,
    adminEmail,
    allowedEmails: allowedEmails.filter(email => email !== adminEmail),
    customDomainEnabled,
    zoneId,
    zoneName,
    appSubdomain,
    mailEnabled,
    mailSubdomain,
    mailLocalPart,
    targetVersion,
    filesEnabled: body.filesEnabled !== false,
  }
}

/** The guided first-run contract intentionally excludes optional infrastructure. */
export function parseBaseInstallRequest(value: unknown): BaseInstallRequest {
  const parsed = parseDeployRequest({
    ...(value && typeof value === 'object' ? value : {}),
    customDomainEnabled: false,
    zoneId: '',
    zoneName: '',
    appSubdomain: '',
    mailEnabled: false,
    mailSubdomain: '',
    mailLocalPart: '',
  })
  const {
    accountId,
    workerName,
    adminEmail,
    allowedEmails,
    appName,
    authMode,
    registrationMode,
    targetVersion,
    filesEnabled,
    backupBucketName,
  } = parsed
  return { accountId, workerName, adminEmail, allowedEmails, appName, authMode, registrationMode, targetVersion, filesEnabled, ...(backupBucketName ? { backupBucketName } : {}) }
}
