import { authorize, resourceAllowed, ServerAction, type AuthorizationContext } from '../../shared/authorization'
import { spaceSql } from '../../shared/spaces'
import type { L4Env } from '../../workers/env'
import { databaseFieldDto, databaseFieldsFor } from './database-data'
import { loadDatabaseViews } from './database-views'

/** Discover table schemas without reading records or unrelated documents. */
export async function listAuthorizedTables(env: L4Env, authorization: AuthorizationContext) {
  authorize(authorization, ServerAction.readRecords)
  const rows = (await env.DB.prepare(`SELECT id,name FROM database_definitions WHERE deleted_at IS NULL AND archived_at IS NULL AND space_id IN (${spaceSql(authorization)}) ORDER BY position,created_at`).all<{ id: string, name: string }>()).results
  return Promise.all(rows.filter(table => resourceAllowed(authorization, 'databases', table.id)).map(async table => {
    const fields = await databaseFieldsFor(env, table.id)
    const views = await loadDatabaseViews(env, table.id, fields)
    return { ...table, fields: fields.map(databaseFieldDto), views }
  }))
}
