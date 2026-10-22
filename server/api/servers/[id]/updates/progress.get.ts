import { serverVersion } from '../../../../utils/version'
import { serverUpdateLaunchUrl, updateConfiguration, updateOwner } from '../../../../utils/server-updates'

export default defineEventHandler(async (event) => {
  setHeader(event, 'Cache-Control', 'no-store')
  const { env, serverId } = await updateOwner(event)
  const config = await updateConfiguration(event, env, serverId)
  return { installedVersion: serverVersion(env), configured: true, mode: 'installer', job: config.value.job, buildUrl: null, launchUrl: await serverUpdateLaunchUrl(env, config.value.job, getRequestURL(event).origin) }
})
