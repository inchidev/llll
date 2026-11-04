import { getServerId } from '../../../shared/server-id'
import { updateDocumentSchema as bodySchema } from '../../../shared/documents'
import { Permission } from '../../../shared/permissions'
import { cf } from '../../utils/cf'
import { updateDocument } from '../../utils/document-service'
import { requireMember } from '../../utils/guards'
import { parseBody } from '../../utils/validate'

export default defineEventHandler(async (event) => {
  const actor = await requireMember(event, (await getServerId(cf(event).env.DB)), Permission.writeData)
  const id = getRouterParam(event, 'id')!
  const body = parseBody(bodySchema, await readBody(event))
  const { env } = cf(event)
  return { document: await updateDocument(env, actor.authorization, id, body) }
})
