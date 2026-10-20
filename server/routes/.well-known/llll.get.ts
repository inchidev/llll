import { SERVER_API_VERSION } from '../../../shared/server'
import { embedOrigins } from '../../../shared/embed'
import { readAppBranding } from '../../../shared/app-branding'
import { version } from '../../../package.json'
import { cf } from '../../utils/cf'
import { ensureMigrated } from '../../utils/db'
import { publicServerAppearance } from '../../utils/server-appearance'

export default defineEventHandler(async event => {
  if (getRequestURL(event).pathname !== '/.well-known/llll') return
  const { env } = cf(event)
  await ensureMigrated(env.DB, env)
  const allowed = embedOrigins(env.EMBED_ORIGINS)
  const origin = getHeader(event, 'origin')
  if (origin && allowed.includes(origin)) { setHeader(event, 'Access-Control-Allow-Origin', origin); setHeader(event, 'Vary', 'Origin') }
  setHeader(event, 'Cache-Control', 'no-store')
  const publicOrigin = env.PUBLIC_ORIGIN || getRequestURL(event).origin
  const appearance = await publicServerAppearance(env.DB, publicOrigin, readAppBranding(env).appName)
  return { product: 'llll', kind: 'server', ...appearance, apiVersion: SERVER_API_VERSION, version, origin: publicOrigin, registration: env.AUTH_REGISTRATION_MODE === 'open', telegram: Boolean(env.TELEGRAM_BOT_TOKEN || env.TELEGRAM_TRUSTED_BOT_ID), embedOrigins: allowed }
})
