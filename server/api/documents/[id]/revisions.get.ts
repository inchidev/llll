import { getServerId } from '../../../../shared/server-id'
import { Permission } from '../../../../shared/permissions'
import { cf } from '../../../utils/cf'
import { requireMember } from '../../../utils/guards'
import { listDocumentRevisions } from '../../../utils/document-revisions'

export default defineEventHandler(async event => {
  const { env } = cf(event)
  const actor = await requireMember(event, await getServerId(env.DB), Permission.readData)
  return { revisions: await listDocumentRevisions(env, actor.authorization, getRouterParam(event, 'id')!) }
})
