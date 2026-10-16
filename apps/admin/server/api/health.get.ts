import { credentialStatus } from '../utils/credential'
import { adminEnv } from '../utils/http'
import { ownerClaimed } from '../utils/session'

export default defineEventHandler(async (event) => {
  setHeader(event, 'Cache-Control', 'no-store')
  const env = adminEnv(event)
  const [claimed, credential] = await Promise.all([ownerClaimed(env), credentialStatus(env)])
  return {
    ok: true,
    version: env.LLLL_VERSION || null,
    claimed,
    cloudflare: credential.connected || credential.pendingHandover ? 'connected' : credential.kind ? 'problem' : 'missing',
  }
})
