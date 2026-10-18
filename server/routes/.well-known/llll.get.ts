import { cf } from '../../utils/cf'
import { version } from '../../../package.json'
import { INSTALLATION_API_VERSION } from '../../../shared/instance'

export default defineEventHandler((event) => {
  const { env } = cf(event)
  return { product: 'llll', kind: 'server', id: env.LLLL_SERVER_ID || 'main', name: env.APP_NAME || 'L4', apiVersion: INSTALLATION_API_VERSION, version, origin: env.PUBLIC_ORIGIN || getRequestURL(event).origin, registration: env.AUTH_REGISTRATION_MODE === 'open', telegram: false }
})
