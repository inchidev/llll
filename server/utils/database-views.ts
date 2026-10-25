import { DatabaseColumnWidth, DatabaseViewFilterOperators, DatabaseViewLayouts, defaultDatabaseViewConfig, type DatabaseValue, type DatabaseViewConfig, type DatabaseViewFilter, type DatabaseViewFilterOperator, type DatabaseViewLayout } from '../../shared/database'
import type { DatabasePageDTO, DatabaseViewDTO } from '../../shared/types'
import type { L4Env } from '../../workers/env'
import { fail } from './cf'
import { databaseFieldDto, databaseFieldsFor, databaseItemDto, requireDatabase, type StoredDatabaseField } from './database-data'

type ViewRow = Omit<DatabaseViewDTO, 'config'> & { configJson: string }
type ItemRow = Parameters<typeof databaseItemDto>[0]

const operators = new Set<string>(DatabaseViewFilterOperators)
const layouts = new Set<string>(DatabaseViewLayouts)

export function validCalendarRange(from: string, to: string): boolean {
  const duration = Date.parse(to) - Date.parse(from)
  return duration >= 0 && duration <= 62 * 86_400_000
}

function fieldFor(fields: StoredDatabaseField[], fieldId: string): StoredDatabaseField | null {
  return fields.find(field => field.id === fieldId) ?? null
}

function fieldType(fields: StoredDatabaseField[], fieldId: string) {
  return fieldId === 'title' ? 'text' : fieldFor(fields, fieldId)?.type ?? null
}

function operatorAllowed(type: ReturnType<typeof fieldType>, operator: DatabaseViewFilterOperator): boolean {
  if (!type) return false
  if (operator === 'is_empty' || operator === 'is_not_empty' || operator === 'equals' || operator === 'not_equals') return true
  if (operator === 'contains') return type === 'text' || type === 'select'
  if (operator === 'greater_than' || operator === 'less_than') return type === 'number'
  return type === 'date'
}

function normalizeFilter(value: unknown, fields: StoredDatabaseField[], strict: boolean): DatabaseViewFilter | null {
  if (!value || typeof value !== 'object') {
    if (strict) fail(400, 'bad_request', 'View filters are invalid')
    return null
  }
  const raw = value as Partial<DatabaseViewFilter>
  const operator = typeof raw.operator === 'string' && operators.has(raw.operator)
    ? raw.operator as DatabaseViewFilterOperator
    : null
  if (typeof raw.fieldId !== 'string' || !operator || !operatorAllowed(fieldType(fields, raw.fieldId), operator)) {
    if (strict) fail(400, 'bad_request', 'A view filter uses an unsupported field or operator')
    return null
  }
  if (operator === 'is_empty' || operator === 'is_not_empty') return { fieldId: raw.fieldId, operator }
  if (!('value' in raw) || (!['string', 'number', 'boolean'].includes(typeof raw.value) && raw.value !== null)) {
    if (strict) fail(400, 'bad_request', 'A view filter is missing its value')
    return null
  }
  if (raw.value === null) {
    if (strict) fail(400, 'bad_request', 'Use an empty-value operator instead of a null filter value')
    return null
  }
  const type = fieldType(fields, raw.fieldId)
  if ((type === 'number' && typeof raw.value !== 'number')
    || (type === 'boolean' && typeof raw.value !== 'boolean')
    || ((type === 'date' || type === 'text' || type === 'select') && typeof raw.value !== 'string')) {
    if (strict) fail(400, 'bad_request', 'A view filter value does not match its field')
    return null
  }
  const field = fieldFor(fields, raw.fieldId)
  if (type === 'select' && operator !== 'contains' && !field?.options.includes(String(raw.value))) {
    if (strict) fail(400, 'bad_request', 'A Select filter must use one of the field options')
    return null
  }
  return { fieldId: raw.fieldId, operator, value: raw.value as DatabaseValue }
}

export function normalizeDatabaseViewConfig(
  value: unknown,
  fields: StoredDatabaseField[],
  layout: DatabaseViewLayout,
  strict = false,
): DatabaseViewConfig {
  const defaults = defaultDatabaseViewConfig()
  const raw = value && typeof value === 'object' ? value as Partial<DatabaseViewConfig> : {}
  const validFieldIds = new Set(fields.map(field => field.id))
  const visibleFieldIds = raw.visibleFieldIds === null
    ? null
    : Array.isArray(raw.visibleFieldIds)
    ? [...new Set(raw.visibleFieldIds.filter((id): id is string => typeof id === 'string' && validFieldIds.has(id)))]
    : defaults.visibleFieldIds
  if (strict && Array.isArray(raw.visibleFieldIds) && visibleFieldIds?.length !== raw.visibleFieldIds.length) {
    fail(400, 'bad_request', 'Visible fields must belong to this database')
  }
  const filters = Array.isArray(raw.filters)
    ? raw.filters.slice(0, 8).map(filter => normalizeFilter(filter, fields, strict)).filter((filter): filter is DatabaseViewFilter => Boolean(filter))
    : defaults.filters
  if (strict && Array.isArray(raw.filters) && raw.filters.length > 8) fail(400, 'bad_request', 'A view can have at most eight filters')
  const sorts = Array.isArray(raw.sorts)
    ? raw.sorts.slice(0, 3).flatMap((sort) => {
        if (!sort || typeof sort !== 'object') return []
        const candidate = sort as { fieldId?: unknown, direction?: unknown }
        if (typeof candidate.fieldId !== 'string' || candidate.fieldId !== 'title' && !validFieldIds.has(candidate.fieldId)
          || candidate.direction !== 'asc' && candidate.direction !== 'desc') return []
        return [{ fieldId: candidate.fieldId, direction: candidate.direction as 'asc' | 'desc' }]
      })
    : defaults.sorts
  if (strict && Array.isArray(raw.sorts) && sorts.length !== raw.sorts.length) fail(400, 'bad_request', 'View sorts are invalid')

  const groupFieldId = typeof raw.groupFieldId === 'string' && fieldFor(fields, raw.groupFieldId)?.type === 'select'
    ? raw.groupFieldId
    : null
  const dateFieldId = typeof raw.dateFieldId === 'string' && fieldFor(fields, raw.dateFieldId)?.type === 'date'
    ? raw.dateFieldId
    : null
  if (strict && layout === 'board' && !groupFieldId) fail(400, 'bad_request', 'Board views require a Select field')
  if (strict && layout === 'calendar' && !dateFieldId) fail(400, 'bad_request', 'Calendar views require a Date field')

  // Widths are presentation only: keep known columns, clamp to the allowed range, drop the rest.
  const columnWidths: Record<string, number> = {}
  if (raw.columnWidths && typeof raw.columnWidths === 'object') {
    for (const [key, width] of Object.entries(raw.columnWidths as Record<string, unknown>)) {
      if ((key !== 'title' && !validFieldIds.has(key)) || typeof width !== 'number' || !Number.isFinite(width)) continue
      columnWidths[key] = Math.round(Math.min(DatabaseColumnWidth.max, Math.max(DatabaseColumnWidth.min, width)))
    }
  }

  return { visibleFieldIds, filters, sorts, groupFieldId, dateFieldId, columnWidths }
}

export function parseDatabaseView(row: ViewRow, fields: StoredDatabaseField[]): DatabaseViewDTO {
  let raw: unknown
  try { raw = JSON.parse(row.configJson) }
  catch { raw = null }
  let layout = layouts.has(row.layout) ? row.layout : 'table'
  const { configJson: _configJson, ...view } = row
  const config = normalizeDatabaseViewConfig(raw, fields, layout)
  if ((layout === 'board' && !config.groupFieldId) || (layout === 'calendar' && !config.dateFieldId)) layout = 'table'
  return { ...view, layout, config }
}

export async function loadDatabaseViews(env: L4Env, databaseId: string, fields?: StoredDatabaseField[]): Promise<DatabaseViewDTO[]> {
  const databaseFields = fields ?? await databaseFieldsFor(env, databaseId)
  const result = await env.DB.prepare(
    `SELECT id, database_id as databaseId, name, layout, config_json as configJson, position, version,
     created_by as createdBy, created_at as createdAt, updated_at as updatedAt
     FROM database_views WHERE database_id = ? ORDER BY position, created_at`,
  ).bind(databaseId).all<ViewRow>()
  return (result.results ?? []).map(row => parseDatabaseView(row, databaseFields))
}

export async function requireDatabaseView(env: L4Env, id: string): Promise<ViewRow> {
  const row = await env.DB.prepare(
    `SELECT id, database_id as databaseId, name, layout, config_json as configJson, position, version,
     created_by as createdBy, created_at as createdAt, updated_at as updatedAt
     FROM database_views WHERE id = ?`,
  ).bind(id).first<ViewRow>()
  if (!row) fail(404, 'not_found', 'Database view not found')
  return row
}

function columnFor(fields: StoredDatabaseField[], fieldId: string): string | null {
  if (fieldId === 'title') return 'title'
  return fieldFor(fields, fieldId)?.slot ?? null
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/gu, match => `\\${match}`)
}

function sqlValue(value: DatabaseValue | undefined): string | number | null {
  return typeof value === 'boolean' ? Number(value) : value ?? null
}

function viewQuery(
  config: DatabaseViewConfig,
  fields: StoredDatabaseField[],
  search: string,
  dateRange?: { from: string, to: string },
) {
  const clauses = ['database_id = ?']
  const values: Array<string | number | null> = []
  for (const filter of config.filters) {
    const column = columnFor(fields, filter.fieldId)
    if (!column) continue
    if (filter.operator === 'is_empty') clauses.push(`(${column} IS NULL OR ${column} = '')`)
    else if (filter.operator === 'is_not_empty') clauses.push(`(${column} IS NOT NULL AND ${column} <> '')`)
    else if (filter.operator === 'contains') {
      clauses.push(`lower(CAST(${column} AS TEXT)) LIKE ? ESCAPE '\\'`)
      values.push(`%${escapeLike(String(filter.value ?? '').toLocaleLowerCase())}%`)
    }
    else {
      const booleanComparison = fieldType(fields, filter.fieldId) === 'boolean' && typeof filter.value === 'boolean'
      const operator = filter.operator === 'equals' ? '='
        : filter.operator === 'not_equals' ? '<>'
          : filter.operator === 'greater_than' || filter.operator === 'after' ? '>' : '<'
      clauses.push(booleanComparison ? `COALESCE(${column}, 0) ${operator} ?` : filter.operator === 'not_equals' ? `(${column} IS NULL OR ${column} ${operator} ?)` : `${column} ${operator} ?`)
      values.push(sqlValue(filter.value))
    }
  }
  const needle = search.trim().toLocaleLowerCase()
  if (needle) {
    const columns = ['title', ...fields.map(field => field.slot)]
    clauses.push(`(${columns.map(column => `lower(CAST(${column} AS TEXT)) LIKE ? ESCAPE '\\'`).join(' OR ')})`)
    const pattern = `%${escapeLike(needle)}%`
    values.push(...columns.map(() => pattern))
  }
  if (dateRange && config.dateFieldId) {
    const column = columnFor(fields, config.dateFieldId)
    if (column) {
      clauses.push(`${column} >= ? AND ${column} <= ?`)
      values.push(dateRange.from, dateRange.to)
    }
  }
  const order = config.sorts.flatMap((sort) => {
    const column = columnFor(fields, sort.fieldId)
    return column ? [`${column} IS NULL`, `${column} COLLATE NOCASE ${sort.direction.toUpperCase()}`] : []
  })
  order.push('position', 'created_at', 'id')
  return { where: clauses.join(' AND '), values, order: order.join(', ') }
}

export async function databaseItemMatchesView(
  env: L4Env,
  databaseId: string,
  viewId: string,
  itemId: string,
): Promise<boolean> {
  const fields = await databaseFieldsFor(env, databaseId)
  const view = (await loadDatabaseViews(env, databaseId, fields)).find(candidate => candidate.id === viewId)
  if (!view) return false
  const query = viewQuery(view.config, fields, '')
  const match = await env.DB.prepare(`SELECT 1 FROM database_items WHERE id = ? AND ${query.where} LIMIT 1`)
    .bind(itemId, databaseId, ...query.values).first()
  return Boolean(match)
}

export async function loadDatabasePage(
  env: L4Env,
  databaseId: string,
  options: { viewId?: string | null, page: number, pageSize: number, search?: string, dateFrom?: string, dateTo?: string },
): Promise<DatabasePageDTO> {
  const definition = await requireDatabase(env, databaseId)
  const fields = await databaseFieldsFor(env, databaseId)
  const views = await loadDatabaseViews(env, databaseId, fields)
  const requestedView = options.viewId ? views.find(candidate => candidate.id === options.viewId) : null
  if (options.viewId && !requestedView) fail(404, 'not_found', 'Database view not found')
  const storedView = requestedView ?? views[0]
  const view = storedView && options.viewId === null ? { ...storedView, layout: 'table' as const, config: defaultDatabaseViewConfig() } : storedView
  if (!view) fail(500, 'missing_database_view', 'This database has no view')
  const dateRange = view.layout === 'calendar' && options.dateFrom && options.dateTo
    ? { from: options.dateFrom, to: options.dateTo }
    : undefined
  const query = viewQuery(view.config, fields, options.search ?? '', dateRange)
  const offset = (options.page - 1) * options.pageSize
  const groupColumn = view.layout === 'board' && view.config.groupFieldId
    ? columnFor(fields, view.config.groupFieldId)
    : null
  const statements = [
    env.DB.prepare(`SELECT COUNT(*) as total FROM database_items WHERE ${query.where}`).bind(databaseId, ...query.values),
    env.DB.prepare(
      `SELECT *, database_id as databaseId, created_by as createdBy,
       created_at as createdAt, updated_at as updatedAt FROM database_items
       WHERE ${query.where} ORDER BY ${query.order} LIMIT ? OFFSET ?`,
    ).bind(databaseId, ...query.values, options.pageSize, offset),
  ]
  if (groupColumn) {
    statements.push(env.DB.prepare(
      `SELECT COALESCE(CAST(${groupColumn} AS TEXT), '') as groupKey, COUNT(*) as total
       FROM database_items WHERE ${query.where} GROUP BY ${groupColumn}`,
    ).bind(databaseId, ...query.values))
  }
  const [countResult, itemsResult, groupResult] = await env.DB.batch(statements)
  const count = (countResult?.results?.[0] as { total?: number } | undefined)?.total ?? 0
  const items = (itemsResult?.results ?? []) as ItemRow[]
  return {
    database: { ...definition, fields: fields.map(databaseFieldDto) },
    views,
    view,
    items: items.map(item => databaseItemDto(item, fields)),
    total: Number(count),
    page: options.page,
    pageSize: options.pageSize,
    ...(groupResult
      ? { groupCounts: Object.fromEntries((groupResult.results ?? []).map(row => [String((row as { groupKey?: unknown }).groupKey ?? ''), Number((row as { total?: unknown }).total ?? 0)])) }
      : {}),
  }
}
