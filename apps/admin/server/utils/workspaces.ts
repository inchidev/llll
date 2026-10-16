import {
  ADMIN_CAPABILITY,
  adoptL4Workspace,
  cloudflareClient,
  installBaseL4,
  listL4Installations,
  readL4Installation,
  rotateOwnerSetupToken,
  uninstallL4,
  updateL4,
  type CloudflareInstallation,
  type DeployProgressReporter,
} from '@llll/admin-core'
import type { AdminEnv } from '../env'
import { cloudflareToken } from './credential'
import { audit } from './db'
import { cleanupDomains, rebuildDomainState } from './domains'
import { fail } from './http'
import { adminWorkerName, compareVersions, latestVersion, manifestUrl } from './releases'
import { randomToken } from './secrets'

export type WorkspaceSummary = {
  workerName: string
  appName: string
  origin: string
  version: string | null
  /** Reaches this Admin through `LLLL_ADMIN`. */
  linked: boolean
  updateAvailable: boolean
  filesEnabled: boolean
}

const WORKER_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u

function link(env: AdminEnv) {
  return { service: adminWorkerName(env) }
}

function summary(installation: CloudflareInstallation, latest: string | null): WorkspaceSummary {
  return {
    workerName: installation.workerName,
    appName: installation.configuration.appName,
    origin: installation.origin,
    version: installation.version,
    linked: installation.resources.admin,
    filesEnabled: Boolean(installation.resources.bucketName),
    updateAvailable: Boolean(latest && installation.version && compareVersions(latest, installation.version) > 0),
  }
}

export async function listWorkspaces(env: AdminEnv): Promise<WorkspaceSummary[]> {
  const token = await cloudflareToken(env)
  const [installations, latest] = await Promise.all([
    listL4Installations(token, env.CLOUDFLARE_ACCOUNT_ID),
    latestVersion(env),
  ])
  return installations.map(installation => summary(installation, latest))
}

export async function requireWorkspace(env: AdminEnv, workerName: string): Promise<CloudflareInstallation> {
  if (!WORKER_NAME.test(workerName)) fail(400, 'Workspace name is invalid')
  const token = await cloudflareToken(env)
  const installation = await readL4Installation(token, env.CLOUDFLARE_ACCOUNT_ID, workerName)
  if (!installation) fail(404, 'Workspace not found in this Cloudflare account')
  return installation
}

export async function workspaceSummary(env: AdminEnv, workerName: string): Promise<WorkspaceSummary> {
  return summary(await requireWorkspace(env, workerName), await latestVersion(env))
}

export async function createWorkspace(
  env: AdminEnv,
  input: { workerName?: unknown, appName?: unknown, ownerEmail?: unknown, filesEnabled?: unknown },
  report: DeployProgressReporter,
) {
  const workerName = typeof input.workerName === 'string' ? input.workerName.trim().toLowerCase() : ''
  const appName = typeof input.appName === 'string' ? input.appName.trim() : ''
  const ownerEmail = typeof input.ownerEmail === 'string' ? input.ownerEmail.trim().toLowerCase() : ''
  if (!WORKER_NAME.test(workerName)) fail(400, 'Use lowercase letters, numbers, and hyphens for the address')
  if (workerName === adminWorkerName(env)) fail(400, 'That address belongs to the L4 Admin')
  if (!appName || appName.length > 80) fail(400, 'Workspace name must be 1–80 characters')
  const token = await cloudflareToken(env)
  if (await readL4Installation(token, env.CLOUDFLARE_ACCOUNT_ID, workerName)) {
    fail(409, `A workspace named ${workerName} already exists in this account`)
  }
  const version = await latestVersion(env)
  const result = await installBaseL4(token, {
    accountId: env.CLOUDFLARE_ACCOUNT_ID,
    workerName,
    appName,
    adminEmail: ownerEmail,
    allowedEmails: [],
    authMode: 'builtin',
    registrationMode: 'invite_only',
    filesEnabled: input.filesEnabled === true,
    ...(version ? { targetVersion: version } : {}),
  }, { admin: link(env), report, manifestUrl: env.LLLL_RELEASE_MANIFEST || undefined })
  await audit(env.ADMIN_DB, 'workspace.create', workerName, { version: result.version })
  return result
}

/** Update a workspace to a release. Releases that support the Admin also link it, adopting its domains. */
export async function updateWorkspace(env: AdminEnv, workerName: string, report?: DeployProgressReporter) {
  const installation = await requireWorkspace(env, workerName)
  const target = await latestVersion(env, true)
  if (!target) fail(502, 'The latest L4 release could not be read')
  const token = await cloudflareToken(env)
  await report?.({ type: 'progress', step: 'release', state: 'active' })
  const result = await updateL4(token, {
    accountId: env.CLOUDFLARE_ACCOUNT_ID,
    workerName,
    targetVersion: target,
  }, { admin: link(env), manifestUrl: env.LLLL_RELEASE_MANIFEST || undefined })
  await report?.({ type: 'progress', step: 'release', state: 'complete', detail: `L4 ${result.version}` })
  if (result.linkedToAdmin && !installation.resources.admin) {
    await adoptState(env, token, workerName)
  }
  await audit(env.ADMIN_DB, 'workspace.update', workerName, { from: installation.version, to: result.version })
  return result
}

async function adoptState(env: AdminEnv, token: string, workerName: string) {
  const settings = await cloudflareClient(token).workers.scripts.scriptAndVersionSettings.get(workerName, { account_id: env.CLOUDFLARE_ACCOUNT_ID })
  await rebuildDomainState(env, token, workerName, (settings.bindings || []) as Array<{ name?: string, type?: string, text?: string }>)
}

/** Link a workspace whose release already supports the Admin, without redeploying it. */
export async function linkWorkspace(env: AdminEnv, workerName: string) {
  const installation = await requireWorkspace(env, workerName)
  const manifest = await fetch(manifestUrl(env, installation.version || undefined))
    .then(response => response.ok ? response.json() as Promise<{ capabilities?: string[] }> : null)
    .catch(() => null)
  if (!manifest?.capabilities?.includes(ADMIN_CAPABILITY)) {
    fail(409, 'Update this workspace first; its release cannot use the L4 Admin yet')
  }
  const token = await cloudflareToken(env)
  await adoptL4Workspace(token, env.CLOUDFLARE_ACCOUNT_ID, workerName, link(env))
  await adoptState(env, token, workerName)
  await audit(env.ADMIN_DB, 'workspace.link', workerName)
  return { linked: true }
}

type SetupHealth = { ready?: unknown, authMode?: unknown }

async function setupHealth(origin: string): Promise<SetupHealth | null> {
  try {
    const response = await fetch(`${origin}/api/setup/health`, { headers: { Accept: 'application/json' }, redirect: 'manual', cache: 'no-store' })
    return response.ok ? await response.json() as SetupHealth : null
  }
  catch {
    return null
  }
}

export async function ownerSetupState(origin: string): Promise<boolean | null> {
  const health = await setupHealth(origin)
  return typeof health?.ready === 'boolean' ? !health.ready : null
}

/** Issue a new private owner setup link for a workspace nobody has claimed yet. */
export async function reissueOwnerSetup(env: AdminEnv, workerName: string) {
  const installation = await requireWorkspace(env, workerName)
  const health = await setupHealth(installation.origin)
  if (!health) fail(502, 'Workspace health could not be verified')
  if (health.ready === true) fail(409, 'This workspace already has an owner')
  if (health.authMode !== 'builtin') fail(409, 'Owner setup links are only used by builtin sign-in')
  const token = await cloudflareToken(env)
  const claim = randomToken(48)
  await rotateOwnerSetupToken(token, env.CLOUDFLARE_ACCOUNT_ID, workerName, claim)
  for (let attempt = 0; attempt < 12; attempt += 1) {
    if (attempt) await new Promise(resolve => setTimeout(resolve, 500))
    try {
      const response = await fetch(`${installation.origin}/api/setup/owner/identity`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ token: claim }),
        redirect: 'manual',
        cache: 'no-store',
      })
      if (response.ok) {
        await audit(env.ADMIN_DB, 'workspace.owner_setup', workerName)
        return { setupUrl: `${installation.origin}/setup#claim=${encodeURIComponent(claim)}` }
      }
    }
    catch { /* retry while the new secret propagates */ }
  }
  fail(502, 'The new owner setup link did not become active')
}

/**
 * Delete a workspace. The workspace owner authorizes it with a deletion claim
 * from Workspace Settings; the workspace empties its own files first.
 */
export async function deleteWorkspace(env: AdminEnv, workerName: string, input: { claim?: unknown, confirmation?: unknown }) {
  const installation = await requireWorkspace(env, workerName)
  const claim = typeof input.claim === 'string' ? input.claim.trim() : ''
  if (!/^[0-9a-f]{64}$/u.test(claim)) fail(401, 'Open server deletion from Workspace Settings again')
  if (input.confirmation !== installation.origin) fail(400, `Type ${installation.origin} to confirm`)
  const token = await cloudflareToken(env)
  const result = await uninstallL4(cloudflareClient(token), token, installation, claim, {
    afterPrepare: () => cleanupDomains(env, token, workerName),
  })
  await audit(env.ADMIN_DB, 'workspace.delete', workerName, { deleted: result.deletedResources.length })
  return result
}
