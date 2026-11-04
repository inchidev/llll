import type { AuthorizationContext } from '../../shared/authorization'
import { authorize, resourceAllowed, ServerAction } from '../../shared/authorization'
import { spaceSql } from '../../shared/spaces'
import type { DataResourcesDTO } from '../../shared/types'
import type { L4Env } from '../../workers/env'
import { loadDataResources } from './data-resources'

export async function listAuthorizedDataResources(
  env: L4Env,
  authorization: AuthorizationContext,
): Promise<DataResourcesDTO> {
  authorize(authorization, ServerAction.readDocuments)
  const data = await loadDataResources(env, authorization.credential.kind === 'session' ? authorization.principal.id : undefined, spaceSql(authorization), authorization)
  return { ...data,
    databases: data.databases.filter(row => resourceAllowed(authorization, 'databases', row.id)),
    documents: data.documents.filter(row => resourceAllowed(authorization, 'documents', row.id)),
    canvases: data.canvases.filter(row => resourceAllowed(authorization, 'canvases', row.id)),
    bookmarks: data.bookmarks.filter(row => row.targetType === 'database_view'
      ? data.databases.some(database => resourceAllowed(authorization, 'databases', database.id) && database.views.some(view => view.id === row.targetId))
      : data.items.some(item=>item.id===row.targetId)),
  }
}
