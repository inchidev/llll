import { credentialStatus } from '../utils/credential'
import { adminEnv } from '../utils/http'
import { automaticUpdates, compareVersions, latestVersion } from '../utils/releases'
import { currentOwner, ownerClaimed } from '../utils/session'

export default defineEventHandler(async (event) => {
  setHeader(event, 'Cache-Control', 'no-store')
  const env = adminEnv(event)
  const owner = await currentOwner(event)
  if (!owner) return { owner: null, claimed: await ownerClaimed(env) }
  const [credential, latest, updates] = await Promise.all([credentialStatus(env), latestVersion(env), automaticUpdates(env)])
  const version = env.LLLL_VERSION || null
  return {
    owner,
    claimed: true,
    accountId: env.CLOUDFLARE_ACCOUNT_ID,
    credential,
    version,
    latestVersion: latest,
    updateAvailable: Boolean(latest && version && compareVersions(latest, version) > 0),
    automaticUpdates: updates,
    directory: Boolean(env.LLLL_DIRECTORY_ENDPOINT && env.LLLL_DIRECTORY_ID),
  }
})
