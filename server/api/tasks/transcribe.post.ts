import { authorize, ServerAction } from '../../../shared/authorization'
import { Permission } from '../../../shared/permissions'
import { anyProjectPermission } from '../../../shared/project-access'
import { getServerId } from '../../../shared/server-id'
import { creationSpaceId } from '../../../shared/spaces'
import { requireVoiceQuota } from '../../utils/space-quota'
import { RECORDING_MAX_VOICE_BYTES } from '../../../shared/task-recordings'
import { cf, fail } from '../../utils/cf'
import { requireMember } from '../../utils/guards'
import { transcribeRecordingVoice } from '../../utils/task-recordings'

/**
 * One chunk (up to a minute) of audio, before a Task exists. `?at=` is where it starts in the recording.
 * The audio is dropped; only the text comes back.
 */
export default defineEventHandler(async (event) => {
  const { env } = cf(event)
  const actor = await requireMember(event, await getServerId(env.DB))
  if (!anyProjectPermission(actor.authorization, Permission.writeTasks)) authorize(actor.authorization, ServerAction.writeTasks)
  const audio = await readRawBody(event, false)
  if (!audio || audio.length <= 44) fail(400, 'bad_request', 'No audio in this request')
  if (audio.length > RECORDING_MAX_VOICE_BYTES) fail(413, 'too_large', 'Send at most a minute of audio at a time.')
  await requireVoiceQuota(env, creationSpaceId(actor.authorization))
  return { segments: await transcribeRecordingVoice(env, actor.user.id, audio, Math.max(0, Number(getQuery(event).at) || 0)) }
})
