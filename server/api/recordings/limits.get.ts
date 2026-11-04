import { getServerId } from '../../../shared/server-id'
import { cf, fail } from '../../utils/cf'
import { requireMember } from '../../utils/guards'
import { recordingKeyOf } from '../../utils/recording-keys'
import { recordingLimits } from '../../utils/task-recordings'

/** What the apps' marking page may offer on this Server, by device key. */
export default defineEventHandler(async (event) => {
  const { env } = cf(event)
  await requireMember(event, await getServerId(env.DB))
  if (!recordingKeyOf(event)) fail(401, 'unauthorized', 'This link does not work')
  return { limits: await recordingLimits(env) }
})
