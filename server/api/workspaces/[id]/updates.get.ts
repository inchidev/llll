import { version as packageVersion } from '../../../../package.json'
import { compareStableVersions, newerStableReleases, stableSemver, type UpdateStatusDTO } from '../../../../shared/releases'
import { cf, fail } from '../../../utils/cf'
import { requireMember } from '../../../utils/guards'
import { llllReleases } from '../../../utils/releases'

export default defineEventHandler(async (event): Promise<UpdateStatusDTO> => {
  setHeader(event, 'Cache-Control', 'no-store')
  const workspaceId = getRouterParam(event, 'id')!
  const member = await requireMember(event, workspaceId)
  if (!member.isOwner) fail(403, 'forbidden', 'Only the owner can manage updates')

  const { env } = cf(event)
  const installedVersion = env.LLLL_VERSION?.trim() || packageVersion
  const management = env.LLLL_SERVER_ID ? 'installation' : 'operator'
  const checkedAt = new Date().toISOString()

  try {
    const releases = await llllReleases()
    const newer = newerStableReleases(installedVersion, releases)
    const latestRelease = releases
      .filter(release => stableSemver(release.tagName))
      .sort((left, right) => compareStableVersions(right.tagName, left.tagName))[0] ?? null

    return {
      installedVersion,
      management,
      latestRelease,
      releasesBehind: newer.length,
      updateAvailable: newer.length > 0,
      checkedAt,
      checkFailed: false,
    }
  }
  catch {
    return {
      installedVersion,
      management,
      latestRelease: null,
      releasesBehind: 0,
      updateAvailable: false,
      checkedAt,
      checkFailed: true,
    }
  }
})
