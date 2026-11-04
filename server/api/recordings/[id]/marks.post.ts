import { getServerId } from '../../../../shared/server-id'
import { cf, fail } from '../../../utils/cf'
import { requireMember } from '../../../utils/guards'
import { recordingKeyOf } from '../../../utils/recording-keys'
import { saveRecordingMarks } from '../../../utils/task-recordings'

/** Marks and frames, by device key, for a recording that device just sent: `marks` and `frames` as JSON, then a `frame` part for each frame, in that order. */
export default defineEventHandler(async (event) => {
  const { env, waitUntil } = cf(event)
  const actor = await requireMember(event, await getServerId(env.DB))
  const key = recordingKeyOf(event)
  if (!key) fail(401, 'unauthorized', 'This link does not work')
  const parts = await readMultipartFormData(event) ?? []
  const marks = parts.find(part => part.name === 'marks')?.data.toString()
  if (!marks) fail(400, 'bad_request', 'Missing marks')
  const parse = (value: string) => {
    try { return JSON.parse(value) as unknown }
    catch { fail(400, 'bad_request', 'These marks can\'t be read') }
  }
  const described = parse(parts.find(part => part.name === 'frames')?.data.toString() || '[]')
  const files = parts.filter(part => part.name === 'frame')
  if (!Array.isArray(described) || described.length !== files.length) fail(400, 'bad_request', 'These marks can\'t be read')
  const frames = files.map((part, index) => ({ name: part.filename || 'frame.jpg', data: new Uint8Array(part.data), marks: described[index] as unknown }))
  await saveRecordingMarks(env, actor.authorization, key.spaceId, getRouterParam(event, 'id')!, frames, parse(marks), waitUntil)
  return { ok: true }
})
