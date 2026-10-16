import type { PublicAuthConfig } from '../../../shared/types'
import { loadAuthRuntimeConfig, publicAuthConfig } from '../../utils/auth-config'
import { cf } from '../../utils/cf'
import { ensureMigrated } from '../../utils/db'

export default defineEventHandler(async (event): Promise<PublicAuthConfig> => {
  setHeader(event, 'Cache-Control', 'no-store')
  const { env } = cf(event)
  await ensureMigrated(env.DB, env)
  return publicAuthConfig(await loadAuthRuntimeConfig(env, getRequestURL(event).origin))
})
