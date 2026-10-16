import { version as packageVersion } from '../../../../package.json'
import { compareStableVersions, newerStableReleases, stableSemver, type UpdateStatusDTO } from '../../../../shared/releases'
import { cf, fail } from '../../../utils/cf'
import { requireMember } from '../../../utils/guards'
import { llllReleases } from '../../../utils/releases'
import { llllAdminWorkspaceUrl } from '../../../../workers/llll-admin'

export default defineEventHandler(async (event): Promise<UpdateStatusDTO> => {
  setHeader(event, 'Cache-Control', 'no-store')
  const workspaceId = getRouterParam(event, 'id')!
  const member = await requireMember(event, workspaceId)
  if (!member.isOwner) fail(403, 'forbidden', 'Only the owner can manage updates')

  const { env } = cf(event)
  const installedVersion = env.LLLL_VERSION?.trim() || packageVersion
  const installationKind = env.LLLL_INSTALLATION === 'llll.gg/v1' ? 'guided' : 'manual'
  const checkedAt = new Date().toISOString()

  try {
    const releases = await llllReleases()
    const newer = newerStableReleases(installedVersion, releases)
    const latestRelease = releases
      .filter(release => stableSemver(release.tagName))
      .sort((left, right) => compareStableVersions(right.tagName, left.tagName))[0] ?? null
    const origin = env.LLLL_APP_HOSTNAME?.trim()
      ? `https://${env.LLLL_APP_HOSTNAME.trim()}`
      : getRequestURL(event).origin
    const upgrade = new URL('/admin', 'https://llll.gg')
    upgrade.searchParams.set('installation', origin)
    // A linked L4 Admin updates the workspace from inside the account.
    const adminUrl = await llllAdminWorkspaceUrl(env)

    return {
      installedVersion,
      installationKind,
      latestRelease,
      releasesBehind: newer.length,
      updateAvailable: newer.length > 0,
      upgradeUrl: adminUrl ?? (installationKind === 'guided' && newer.length ? upgrade.toString() : null),
      checkedAt,
      checkFailed: false,
    }
  }
  catch {
    return {
      installedVersion,
      installationKind,
      latestRelease: null,
      releasesBehind: 0,
      updateAvailable: false,
      upgradeUrl: null,
      checkedAt,
      checkFailed: true,
    }
  }
})
