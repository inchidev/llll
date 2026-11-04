import { getServerId } from '../../shared/server-id'
import { cf } from '../utils/cf'
import { requireMember } from '../utils/guards'
import { parseBody } from '../utils/validate'
import { dataReferenceSchema, listDataReferences } from '../utils/data-references'

export default defineEventHandler(async event => {
  const { env } = cf(event)
  const actor = await requireMember(event, await getServerId(env.DB))
  const input = parseBody(dataReferenceSchema, getQuery(event))
  return listDataReferences(env, actor.authorization, input.type, input.id)
})
