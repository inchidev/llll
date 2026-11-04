import { cf } from '../../utils/cf'
import { requireUser } from '../../utils/auth'
import { listRecordingKeys } from '../../utils/recording-keys'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  return { keys: await listRecordingKeys(cf(event).env, user.id) }
})
