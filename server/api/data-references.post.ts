import { getServerId } from '../../shared/server-id'
import { cf } from '../utils/cf'
import { requireMember } from '../utils/guards'
import { parseBody } from '../utils/validate'
import { dataReferenceWriteSchema, changeDataReference } from '../utils/data-references'

export default defineEventHandler(async event => {
  const { env } = cf(event)
  const actor = await requireMember(event, await getServerId(env.DB))
  return changeDataReference(env, actor.authorization, parseBody(dataReferenceWriteSchema, await readBody(event)))
})
