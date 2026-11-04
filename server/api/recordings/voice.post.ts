import { Permission } from '../../../shared/permissions'
import { anyProjectPermission } from '../../../shared/project-access'
import { getServerId } from '../../../shared/server-id'
import { authorize, ServerAction } from '../../../shared/authorization'
import { RECORDING_MAX_VOICE_BYTES } from '../../../shared/task-recordings'
import { cf, fail } from '../../utils/cf'
import { requireMember } from '../../utils/guards'
import { recordingKeyOf } from '../../utils/recording-keys'
import { requireVoiceQuota } from '../../utils/space-quota'
import { transcribeRecordingVoice } from '../../utils/task-recordings'

/** One chunk of audio from the apps' marking page, by device key. The audio is dropped; only the text comes back. */
export default defineEventHandler(async (event) => {
  const { env } = cf(event)
  const actor = await requireMember(event, await getServerId(env.DB))
  const key = recordingKeyOf(event)
  if (!key) fail(401, 'unauthorized', 'This link does not work')
  if (!anyProjectPermission(actor.authorization, Permission.writeTasks)) authorize(actor.authorization, ServerAction.writeTasks)
  const audio = await readRawBody(event, false)
  if (!audio || audio.length <= 44) fail(400, 'bad_request', 'No audio in this request')
  if (audio.length > RECORDING_MAX_VOICE_BYTES) fail(413, 'too_large', 'Send at most a minute of audio at a time.')
  await requireVoiceQuota(env, key.spaceId)
  return { segments: await transcribeRecordingVoice(env, actor.user.id, audio, Math.max(0, Number(getQuery(event).at) || 0)) }
})
