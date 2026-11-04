import { recordingKeyPatchSchema } from '../../../../shared/task-recordings'
import { requireUser } from '../../../utils/auth'
import { cf } from '../../../utils/cf'
import { rememberRecordingBoard } from '../../../utils/recording-keys'
import { parseBody } from '../../../utils/validate'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const { boardId } = parseBody(recordingKeyPatchSchema, await readBody(event))
  await rememberRecordingBoard(cf(event).env, user.id, getRouterParam(event, 'id')!, boardId)
  return { ok: true }
})
