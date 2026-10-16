import {
  deployL4Admin,
  latestReleaseVersion,
  loadAdminRelease,
  releaseManifestUrl,
  type DeployProgressReporter,
} from '@llll/admin-core'
import type { AdminEnv } from '../env'
import { cloudflareToken } from './credential'
import { audit, readMeta, writeMeta } from './db'

const LATEST_TTL_MS = 60 * 60_000

export function manifestUrl(env: AdminEnv, version?: string): string {
  return env.LLLL_RELEASE_MANIFEST?.trim() || releaseManifestUrl(version)
}

export function adminWorkerName(env: AdminEnv): string {
  return env.ADMIN_WORKER_NAME?.trim() || 'llll-admin'
}

/** Compares `x.y.z` versions; pre-release suffixes sort before their release. */
export function compareVersions(left: string, right: string): number {
  const parse = (value: string) => {
    const [core = '', pre = ''] = value.replace(/^v/u, '').split('-', 2)
    return { parts: core.split('.').map(part => Number(part) || 0), pre }
  }
  const a = parse(left)
  const b = parse(right)
  for (let index = 0; index < 3; index += 1) {
    const difference = (a.parts[index] ?? 0) - (b.parts[index] ?? 0)
    if (difference) return Math.sign(difference)
  }
  if (a.pre === b.pre) return 0
  if (!a.pre) return 1
  if (!b.pre) return -1
  return a.pre < b.pre ? -1 : 1
}

/** The newest published L4 release, checked at most hourly. */
export async function latestVersion(env: AdminEnv, force = false): Promise<string | null> {
  const cached = await readMeta(env.ADMIN_DB, 'latest_release')
  if (cached && !force) {
    const { version, checkedAt } = JSON.parse(cached) as { version: string, checkedAt: number }
    if (Date.now() - checkedAt < LATEST_TTL_MS) return version
  }
  try {
    const version = env.LLLL_RELEASE_MANIFEST
      ? (await (await fetch(env.LLLL_RELEASE_MANIFEST)).json() as { version: string }).version
      : await latestReleaseVersion()
    await writeMeta(env.ADMIN_DB, 'latest_release', JSON.stringify({ version, checkedAt: Date.now() }))
    return version
  }
  catch {
    return cached ? (JSON.parse(cached) as { version: string }).version : null
  }
}

/** Replace the Admin's own code with the newest release. Bindings and secrets stay. */
export async function updateAdmin(env: AdminEnv, report?: DeployProgressReporter) {
  const current = env.LLLL_VERSION || '0.0.0'
  const latest = await latestVersion(env, true)
  if (!latest || compareVersions(latest, current) <= 0) return { version: current, updated: false }
  const release = await loadAdminRelease(manifestUrl(env, latest))
  const token = await cloudflareToken(env)
  const result = await deployL4Admin(token, { accountId: env.CLOUDFLARE_ACCOUNT_ID, workerName: adminWorkerName(env) }, release, report, { verify: false })
  await audit(env.ADMIN_DB, 'admin.update', adminWorkerName(env), { from: current, to: result.version })
  return { version: result.version, updated: true }
}

export type AutomaticUpdates = { admin: boolean, workspaces: boolean }

export async function automaticUpdates(env: AdminEnv): Promise<AutomaticUpdates> {
  const value = await readMeta(env.ADMIN_DB, 'automatic_updates')
  const parsed = value ? JSON.parse(value) as Partial<AutomaticUpdates> : {}
  // The Admin keeps itself current by default; workspace updates are the owner's call.
  return { admin: parsed.admin !== false, workspaces: parsed.workspaces === true }
}

export async function setAutomaticUpdates(env: AdminEnv, value: AutomaticUpdates) {
  await writeMeta(env.ADMIN_DB, 'automatic_updates', JSON.stringify(value))
}
