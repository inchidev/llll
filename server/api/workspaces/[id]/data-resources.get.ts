import type { DataResourcesDTO } from '../../../../shared/types'
import { Permission } from '../../../../shared/permissions'
import { cf } from '../../../utils/cf'
import { listAuthorizedDataResources } from '../../../utils/document-service'
import { requireMember } from '../../../utils/guards'

export default defineEventHandler(async (event): Promise<DataResourcesDTO> => {
  const workspaceId = getRouterParam(event, 'id')!
  const actor = await requireMember(event, workspaceId, Permission.manageDatabases)
  return listAuthorizedDataResources(cf(event).env, actor.authorization)
})
