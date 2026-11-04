import { hasPermission, Permission } from '../../../shared/permissions'
import { getServerId } from '../../../shared/server-id'
import { creationSpaceId } from '../../../shared/spaces'
import { recordingKeyCreateSchema } from '../../../shared/task-recordings'
import { cf, fail } from '../../utils/cf'
import { requireMember } from '../../utils/guards'
import { writeAudit } from '../../utils/messages'
import { createRecordingKey } from '../../utils/recording-keys'
import { parseBody } from '../../utils/validate'

/** A key for one device, working in the Space on screen now. */
export default defineEventHandler(async (event) => {
  const { env } = cf(event)
  const actor = await requireMember(event, await getServerId(env.DB))
  const { name } = parseBody(recordingKeyCreateSchema, await readBody(event))
  const spaceId = creationSpaceId(actor.authorization)
  if (!spaceId) fail(400, 'choose_space', 'Choose a Space first')
  if (!actor.isOwner && !hasPermission(actor.authorization.principal.permissions, Permission.attachFiles)) fail(403, 'forbidden', 'Your Role can’t attach files, so a key would do nothing')
  const key = await createRecordingKey(env, actor.user.id, spaceId, name)
  await writeAudit(env, { serverId: actor.authorization.serverId, actorId: actor.user.id, action: 'recording_key.create', targetType: 'mcp_token', targetId: key.id, meta: { name, spaceId }, authorization: actor.authorization })
  setResponseHeader(event, 'Cache-Control', 'no-store')
  return { key }
})
