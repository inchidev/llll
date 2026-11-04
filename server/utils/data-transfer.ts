import { z } from 'zod'
import { authorize, authorizeResource, ServerAction, type AuthorizationContext } from '../../shared/authorization'
import { csvCell } from '../../shared/data-csv'
import { dataError } from '../../shared/data-errors'
import type { L4Env } from '../../workers/env'
import { createRecord, createRecordSchema } from './record-service'
import { databaseFieldsFor, prepareRecordValues, requireDatabase } from './database-data'
import { loadDatabasePage } from './database-views'
import { fail } from './cf'

export const bulkRecordsSchema = z.object({
  databaseId: z.string().min(1),
  rows: z.array(z.record(z.string(), z.unknown())).min(1).max(50),
  preview: z.boolean().default(true),
})

/** Each row is independent and retry-safe; previews use the same value validator as writes. */
export async function bulkCreateRecords(env: L4Env, auth: AuthorizationContext, input: z.input<typeof bulkRecordsSchema>) {
  authorize(auth, ServerAction.writeRecords)
  const body = bulkRecordsSchema.parse(input)
  authorizeResource(auth, 'databases', body.databaseId)
  await requireDatabase(env, body.databaseId, true, auth)
  const fields = new Map((await databaseFieldsFor(env, body.databaseId)).map(field => [field.id, field]))
  const results = []
  for (const [index, inputRow] of body.rows.entries()) {
    const requestId = typeof inputRow.requestId === 'string' ? inputRow.requestId : null
    try {
      const row = createRecordSchema.safeExtend({ requestId: z.string().min(1).max(120) }).parse(inputRow)
      if (body.preview) await prepareRecordValues(env, fields, row.values ?? {}, () => fail(400, 'unknown_field', 'A supplied field does not belong to this Database'), id => authorizeResource(auth, 'databases', id))
      const item = body.preview ? null : await createRecord(env, auth, body.databaseId, row)
      results.push({ index, requestId: row.requestId, ok: true as const, recordId: item?.id ?? null })
    }
    catch (error) { results.push({ index, requestId, ok: false as const, error: dataError(error) }) }
  }
  return { preview: body.preview, results }
}

export async function exportDatabaseCsv(env: L4Env, auth: AuthorizationContext, databaseId: string, options: { viewId?: string; search?: string; spreadsheetSafe?: boolean; dateFrom?: string; dateTo?: string }) {
  authorize(auth, ServerAction.readRecords)
  authorizeResource(auth, 'databases', databaseId)
  const first = await loadDatabasePage(env, databaseId, { viewId: options.viewId, search: options.search ?? '', page: 1, pageSize: 100, authorization: auth, dateFrom: options.dateFrom, dateTo: options.dateTo })
  if (first.total > 10_000) fail(413, 'export_too_large', 'Filter the view to at most 10,000 records before exporting')
  const visible = first.view.config.visibleFieldIds
  const fields = visible === null ? first.database.fields : visible.flatMap(id => first.database.fields.filter(field => field.id === id))
  const rows = [['Title', ...fields.map(field => field.name)].map(value => csvCell(value, options.spreadsheetSafe)).join(',')]
  let bytes = new TextEncoder().encode(rows[0]!).byteLength + 2
  const append = (items: typeof first.items) => {
    for (const item of items) {
      const line = [item.title, ...fields.map(field => item.values[field.id] ?? null)].map(value => csvCell(value, options.spreadsheetSafe)).join(',')
      bytes += new TextEncoder().encode(line).byteLength + 2
      if (bytes > 10 * 1024 * 1024) fail(413, 'export_too_large', 'Filter the view to produce a CSV smaller than 10 MB')
      rows.push(line)
    }
  }
  append(first.items)
  for (let page = 2; (page - 1) * 100 < first.total; page++) {
    const next = await loadDatabasePage(env, databaseId, { viewId: first.view.id, search: options.search ?? '', page, pageSize: 100, authorization: auth, dateFrom: options.dateFrom, dateTo: options.dateTo })
    append(next.items)
  }
  return rows.join('\r\n') + '\r\n'
}
