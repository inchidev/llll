export type PublishedRelease = {
  tagName: string
  name: string
  publishedAt: string
  url: string
  notes: string
}

export type UpdateStatusDTO = {
  installedVersion: string
  management: 'operator'
  latestRelease: PublishedRelease | null
  releasesBehind: number
  updateAvailable: boolean
  checkedAt: string
  checkFailed: boolean
  releases?: PublishedRelease[]
  updateControl?: {
    available: boolean
    configured: boolean
    source: 'binding' | 'saved' | null
    job: import('./server-updates').ServerUpdateJob | null
    buildUrl?: string | null
    reason: string | null
  }
}

export type ServerManagementStatusDTO = {
  available: boolean
  workerName: string | null
  hostname: string | null
  customDomainEnabled: boolean
  liveEnabled: boolean
  emailEnabled: boolean
  emailDomains: string[]
  emailEligible: boolean
}

export type ServerDomainSettingsDTO = {
  managed: boolean
  zones: Array<{ id: string, name: string, status: string }>
  appDomain: null | { hostname: string, zoneId: string, zoneName: string }
  /**
   * `sendingEnabled` is false for a domain that receives mail but cannot send it;
   * connecting it again repairs it.
   */
  emailDomains: Array<{ id: string, domain: string, zoneId: string, zoneName: string, sendingEnabled?: boolean }>
}

type Semver = readonly [major: number, minor: number, patch: number]

const LLLL_RELEASES_URL = 'https://github.com/inchidev/llll/releases/tag'

export function llllReleaseUrl(version: string): string {
  const tag = version.trim().replace(/^v/, '')
  return `${LLLL_RELEASES_URL}/v${tag}`
}

export function stableSemver(value: string): Semver | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(value.trim())
  if (!match) return null
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

export function compareStableVersions(left: string, right: string): number {
  const a = stableSemver(left)
  const b = stableSemver(right)
  if (!a || !b) return 0
  for (let index = 0; index < a.length; index += 1) {
    if (a[index]! !== b[index]!) return a[index]! - b[index]!
  }
  return 0
}

export function newerStableReleases(installedVersion: string, releases: PublishedRelease[]): PublishedRelease[] {
  if (!stableSemver(installedVersion)) return []
  return releases
    .filter(release => stableSemver(release.tagName) && compareStableVersions(release.tagName, installedVersion) > 0)
    .sort((left, right) => compareStableVersions(right.tagName, left.tagName))
}
