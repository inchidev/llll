import { SERVER_API_VERSION } from '../../../shared/server'
import { embedOrigins } from '../../../shared/embed'
import { readAppBranding } from '../../../shared/app-branding'

import { cf } from '../../utils/cf'
import { ensureMigrated } from '../../utils/db'
import { ensurePrimaryServerOrigin, readServerOrigins } from '../../utils/server-origins'
import { publicServerAppearance } from '../../utils/server-appearance'
import { serverRegistrationOpen } from '../../utils/server-flags'
import { serverVersion } from '../../utils/version'

export default defineEventHandler(async event => {
  if (getRequestURL(event).pathname !== '/.well-known/llll') return
  const { env } = cf(event)
  await ensureMigrated(env.DB, env)
  const requestOrigin = getRequestURL(event).origin
  await ensurePrimaryServerOrigin(env, requestOrigin)
  const origins = await readServerOrigins(env, requestOrigin)
  const origin = origins.find(item => item.primary)?.origin || env.PUBLIC_ORIGIN || requestOrigin
  const aliases = origins.filter(item => item.origin !== origin).map(item => item.origin)
  const allowed = embedOrigins(env.EMBED_ORIGINS)
  const cors = getHeader(event, 'origin')
  if (cors && allowed.includes(cors)) { setHeader(event, 'Access-Control-Allow-Origin', cors); setHeader(event, 'Vary', 'Origin') }
  setHeader(event, 'Cache-Control', 'no-store')
  const appearance = await publicServerAppearance(env.DB, requestOrigin, readAppBranding(env).appName)
  return {
    product: 'llll',
    kind: 'server',
    ...appearance,
    apiVersion: SERVER_API_VERSION,
    version: serverVersion(env),
    origin,
    aliases,
    registration: await serverRegistrationOpen(env),
    telegram: Boolean(env.TELEGRAM_BOT_TOKEN || env.TELEGRAM_TRUSTED_BOT_ID),
    embedOrigins: allowed,
  }
})
