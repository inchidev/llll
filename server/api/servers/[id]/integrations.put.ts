import { cf, fail, originOk } from '../../../utils/cf'
import { requireMember } from '../../../utils/guards'
import { requireIntegrationOwner, updateIntegrations } from '../../../utils/integrations'
import { writeAudit } from '../../../utils/messages'

export default defineEventHandler(async event => {
  setHeader(event, 'Cache-Control', 'no-store')
  if (!await originOk(event)) fail(403, 'origin_denied', 'Change this from the Server itself')
  const serverId = getRouterParam(event, 'id')!
  const member = await requireMember(event, serverId)
  requireIntegrationOwner(member)
  const { env } = cf(event)
  const changed = await updateIntegrations(env, await readBody(event))
  // Names only: the audit never holds a value.
  await writeAudit(env, { serverId, actorId: member.user.id, action: 'server.integrations.update', targetType: 'server', targetId: serverId, meta: { changed }, authorization: member.authorization })
  return { ok: true }
})
