import { SERVER_API_VERSION } from '../../../shared/server'
import { embedOrigins } from '../../../shared/embed'
import { getServerId } from '../../../shared/server-id'
import { readAppBranding } from '../../../shared/app-branding'
import { version } from '../../../package.json'
import { cf } from '../../utils/cf'
import { ensureMigrated, serverReady } from '../../utils/db'

export default defineEventHandler(async event => {
  if (getRequestURL(event).pathname !== '/.well-known/llll') return
  const { env } = cf(event)
  await ensureMigrated(env.DB, env)
  const allowed = embedOrigins(env.EMBED_ORIGINS)
  const origin = getHeader(event, 'origin')
  if (origin && allowed.includes(origin)) { setHeader(event, 'Access-Control-Allow-Origin', origin); setHeader(event, 'Vary', 'Origin') }
  setHeader(event, 'Cache-Control', 'no-store')
  return { product: 'llll', kind: 'server', id: await getServerId(env.DB), name: readAppBranding(env).appName, apiVersion: SERVER_API_VERSION, version, origin: env.PUBLIC_ORIGIN || getRequestURL(event).origin, registration: env.AUTH_REGISTRATION_MODE === 'open', telegram: Boolean(env.TELEGRAM_BOT_TOKEN || env.TELEGRAM_TRUSTED_BOT_ID), embedOrigins: allowed, ready: await serverReady(env.DB) }
})
