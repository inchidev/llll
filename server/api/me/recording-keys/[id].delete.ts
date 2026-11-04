import { requireUser } from '../../../utils/auth'
import { cf } from '../../../utils/cf'
import { revokeRecordingKey } from '../../../utils/recording-keys'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  await revokeRecordingKey(cf(event).env, user.id, getRouterParam(event, 'id')!)
  return { ok: true }
})
