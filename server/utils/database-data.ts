import { databaseSlots, isDatabaseSlot, type DatabaseFieldType, type DatabaseValue } from '../../shared/database'
import type { DatabaseDTO, DatabaseFieldDTO, DatabaseItemDTO } from '../../shared/types'
import type { L4Env } from '../../workers/env'
import { fail } from './cf'

type DefinitionRow = Omit<DatabaseDTO, 'fields' | 'items'>
export type StoredDatabaseField = DatabaseFieldDTO & { slot: string }
type FieldRow = Omit<StoredDatabaseField, 'options'> & { configJson: string }
type ItemRow = Omit<DatabaseItemDTO, 'values'> & Record<string, unknown>

export function parseDatabaseField(row: FieldRow): StoredDatabaseField {
  let options: string[] = []
  try {
    const config = JSON.parse(row.configJson) as { options?: unknown }
    if (Array.isArray(config.options)) options = config.options.filter((value): value is string => typeof value === 'string')
  }
  catch {
    options = []
  }
  const { configJson: _configJson, ...field } = row
  return { ...field, options }
}

export function databaseFieldDto(field: StoredDatabaseField): DatabaseFieldDTO {
  const { slot: _slot, ...publicField } = field
  return publicField
}

export function databaseItemDto(row: ItemRow, fields: StoredDatabaseField[]): DatabaseItemDTO {
  const values: Record<string, DatabaseValue> = {}
  for (const field of fields) {
    const raw = row[field.slot]
    values[field.id] = field.type === 'boolean' && raw !== null && raw !== undefined ? Boolean(raw) : (raw as DatabaseValue ?? null)
  }
  return {
    id: row.id,
    databaseId: row.databaseId,
    title: row.title,
    position: row.position,
    version: row.version,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    values,
  }
}

export async function loadDatabases(env: L4Env, includeArchived = false): Promise<DatabaseDTO[]> {
  const archivedClause = includeArchived ? '' : 'WHERE archived_at IS NULL'
  const [definitionsResult, fieldsResult, itemsResult] = await Promise.all([
    env.DB.prepare(
      `SELECT id, name, position, created_by as createdBy, archived_at as archivedAt,
       created_at as createdAt, updated_at as updatedAt
       FROM database_definitions ${archivedClause} ORDER BY position, created_at`,
    ).all<DefinitionRow>(),
    env.DB.prepare(
      `SELECT id, database_id as databaseId, name, type, slot, config_json as configJson, position,
       created_at as createdAt, updated_at as updatedAt
       FROM database_fields ORDER BY position, created_at`,
    ).all<FieldRow>(),
    env.DB.prepare(
      `SELECT *, database_id as databaseId, created_by as createdBy,
       created_at as createdAt, updated_at as updatedAt
       FROM database_items ORDER BY position, created_at`,
    ).all<ItemRow>(),
  ])
  const fields = (fieldsResult.results ?? []).map(parseDatabaseField)
  const items = itemsResult.results ?? []
  return (definitionsResult.results ?? []).map(database => {
    const databaseFields = fields.filter(field => field.databaseId === database.id)
    return {
      ...database,
      fields: databaseFields.map(databaseFieldDto),
      items: items.filter(item => item.databaseId === database.id).map(item => databaseItemDto(item, databaseFields)),
    }
  })
}

export async function loadDatabaseItem(env: L4Env, itemId: string): Promise<DatabaseItemDTO | null> {
  const row = await env.DB.prepare(
    `SELECT id, database_id as databaseId, title, position, version, created_by as createdBy,
     created_at as createdAt, updated_at as updatedAt, * FROM database_items WHERE id = ?`,
  ).bind(itemId).first<ItemRow>()
  if (!row) return null
  const fieldsResult = await env.DB.prepare(
    `SELECT id, database_id as databaseId, name, type, slot, config_json as configJson, position,
     created_at as createdAt, updated_at as updatedAt FROM database_fields
     WHERE database_id = ? ORDER BY position, created_at`,
  ).bind(row.databaseId).all<FieldRow>()
  return databaseItemDto(row, (fieldsResult.results ?? []).map(parseDatabaseField))
}

export async function requireDatabase(env: L4Env, id: string, writable = false): Promise<DefinitionRow> {
  const database = await env.DB.prepare(
    `SELECT id, name, position, created_by as createdBy, archived_at as archivedAt,
     created_at as createdAt, updated_at as updatedAt FROM database_definitions WHERE id = ?`,
  ).bind(id).first<DefinitionRow>()
  if (!database) fail(404, 'not_found', 'Database not found')
  if (writable && database.archivedAt) fail(409, 'database_archived', 'Restore the database before changing it')
  return database
}

export async function requireDatabaseField(env: L4Env, id: string): Promise<StoredDatabaseField> {
  const field = await env.DB.prepare(
    `SELECT id, database_id as databaseId, name, type, slot, config_json as configJson, position,
     created_at as createdAt, updated_at as updatedAt FROM database_fields WHERE id = ?`,
  ).bind(id).first<FieldRow>()
  if (!field) fail(404, 'not_found', 'Database field not found')
  if (!isDatabaseSlot(field.type, field.slot)) fail(500, 'invalid_field_slot', 'Database field has an invalid storage slot')
  return parseDatabaseField(field)
}

export async function requireDatabaseItem(env: L4Env, id: string): Promise<ItemRow> {
  const item = await env.DB.prepare(
    `SELECT id, database_id as databaseId, title, position, version, created_by as createdBy,
     created_at as createdAt, updated_at as updatedAt, * FROM database_items WHERE id = ?`,
  ).bind(id).first<ItemRow>()
  if (!item) fail(404, 'not_found', 'Database item not found')
  return item
}

export async function databaseFieldsFor(env: L4Env, databaseId: string): Promise<StoredDatabaseField[]> {
  const result = await env.DB.prepare(
    `SELECT id, database_id as databaseId, name, type, slot, config_json as configJson, position,
     created_at as createdAt, updated_at as updatedAt FROM database_fields
     WHERE database_id = ? ORDER BY position, created_at`,
  ).bind(databaseId).all<FieldRow>()
  return (result.results ?? []).map(parseDatabaseField)
}

export async function allocateDatabaseSlot(env: L4Env, databaseId: string, type: DatabaseFieldType): Promise<string> {
  const usedResult = await env.DB.prepare(
    'SELECT slot FROM database_fields WHERE database_id = ? AND type = ?',
  ).bind(databaseId, type).all<{ slot: string }>()
  const used = new Set((usedResult.results ?? []).map(row => row.slot))
  const slot = databaseSlots(type).find(candidate => !used.has(candidate))
  if (!slot) fail(409, 'field_limit', `This database has reached its ${type} field limit`)
  return slot
}

export function databaseSqlValue(field: DatabaseFieldDTO, value: unknown): string | number | null {
  if (value === null || value === undefined || value === '') return null
  if (field.type === 'text') {
    if (typeof value !== 'string' || value.length > 5000) fail(400, 'bad_request', `${field.name} must be text under 5000 characters`)
    return value
  }
  if (field.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) fail(400, 'bad_request', `${field.name} must be a number`)
    return value
  }
  if (field.type === 'boolean') {
    if (typeof value !== 'boolean') fail(400, 'bad_request', `${field.name} must be true or false`)
    return value ? 1 : 0
  }
  if (field.type === 'date') {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
      fail(400, 'bad_request', `${field.name} must be a date`)
    }
    return value
  }
  if (typeof value !== 'string' || !field.options.includes(value)) fail(400, 'bad_request', `${field.name} has an unsupported option`)
  return value
}
