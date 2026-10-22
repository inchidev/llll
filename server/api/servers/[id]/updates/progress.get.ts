import { version } from '../../../../../package.json'
import { serverUpdateBuildUrl, serverUpdateLaunchUrl, updateConfiguration, updateOwner } from '../../../../utils/server-updates'

export default defineEventHandler(async (event) => {
  setHeader(event, 'Cache-Control', 'no-store')
  const { env, serverId } = await updateOwner(event)
  const config = await updateConfiguration(event, env, serverId)
  return { installedVersion: env.LLLL_VERSION?.trim() || version, configured: Boolean(config.hook), mode: config.hook ? 'build' : 'installer', job: config.value.job, buildUrl: serverUpdateBuildUrl(env, config.value.job?.buildId), launchUrl: serverUpdateLaunchUrl(env, config.value.job, getRequestURL(event).origin) }
})
