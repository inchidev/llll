import { DEFAULT_APP_TITLE, readAppBranding } from '../../../shared/app-branding'
import { cf } from '../../utils/cf'
import { ensureMigrated } from '../../utils/db'
import { publicServerAppearance } from '../../utils/server-appearance'

export default defineEventHandler(async event => {
  const { env } = cf(event)
  await ensureMigrated(env.DB, env)
  const appearance = await publicServerAppearance(env.DB, getRequestURL(event).origin, readAppBranding(env).appName)
  setHeader(event, 'Content-Type', 'application/manifest+json; charset=utf-8')
  setHeader(event, 'Cache-Control', 'no-cache')
  return {
    id: '/', start_url: '/', scope: '/', display: 'standalone',
    name: appearance.name, short_name: appearance.name,
    description: DEFAULT_APP_TITLE,
    background_color: '#000000', theme_color: '#000000',
    icons: appearance.iconUrl ? [{ src: appearance.iconUrl }] : [
      { src: '/android-chrome-192x192.png', sizes: '192x192', type: 'image/png' },
      { src: '/android-chrome-512x512.png', sizes: '512x512', type: 'image/png' },
    ],
  }
})
