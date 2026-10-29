import { acceptCloudflareHandoff } from '../../utils/cloudflare-account-access'
import { cf } from '../../utils/cf'

/**
 * The official installer hands over its Cloudflare grant with a single-use
 * capability it registered in this Server's D1. No session is involved.
 */
export default defineEventHandler(async event => {
  setHeader(event, 'Cache-Control', 'no-store')
  const token = getRequestHeader(event, 'authorization')?.replace(/^Bearer /u, '') ?? ''
  await acceptCloudflareHandoff(cf(event).env, token, await readBody(event))
  return { connected: true }
})
