import { z } from 'zod'
import { saveCloudflareToken } from '../../../utils/cloudflare-account-access'
import { cf, fail, originOk } from '../../../utils/cf'
import { writeAudit } from '../../../utils/messages'
import { serverDeployment, updateOwner } from '../../../utils/server-updates'
import { parseBody } from '../../../utils/validate'

/** The Owner pastes an API token instead of handing over the installer's grant. */
export default defineEventHandler(async event => {
  setHeader(event, 'Cache-Control', 'no-store')
  if (!await originOk(event)) fail(403, 'origin_denied', 'Connect Cloudflare from this Server')
  const { env, member, serverId } = await updateOwner(event)
  const deployment = await serverDeployment(env)
  if (!deployment) fail(409, 'cloudflare_unavailable', 'This Server does not run on Cloudflare')
  const { token } = parseBody(z.object({ token: z.string().trim().min(20).max(400) }), await readBody(event))
  await saveCloudflareToken(cf(event).env, deployment.accountId, token)
  await writeAudit(env, { serverId, actorId: member.user.id, action: 'cloudflare.access.connect', targetType: 'server', targetId: serverId, meta: { kind: 'token' } })
  return { connected: true }
})
