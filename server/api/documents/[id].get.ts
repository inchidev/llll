import { WORKSPACE_ID } from '../../../shared/ids'
import { Permission } from '../../../shared/permissions'
import type { DocumentDTO } from '../../../shared/types'
import { cf } from '../../utils/cf'
import { getDocument } from '../../utils/document-service'
import { requireMember } from '../../utils/guards'

export default defineEventHandler(async (event): Promise<{ document: DocumentDTO }> => {
  const actor = await requireMember(event, WORKSPACE_ID, Permission.manageDatabases)
  const document = await getDocument(cf(event).env, actor.authorization, getRouterParam(event, 'id')!)
  return { document }
})
