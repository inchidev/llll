import { readAppBranding } from '../../../shared/app-branding'
import { cf } from '../../utils/cf'
import { ensureMigrated } from '../../utils/db'
import { publicServerAppearance } from '../../utils/server-appearance'

export default defineEventHandler(async event => {
  const { env } = cf(event)
  await ensureMigrated(env.DB, env)
  const appearance = await publicServerAppearance(env.DB, getRequestURL(event).origin, readAppBranding(env).appName)
  setHeader(event, 'Cache-Control', 'no-cache')
  return sendRedirect(event, appearance.iconUrl || '/apple-touch-icon.png', 302)
})
