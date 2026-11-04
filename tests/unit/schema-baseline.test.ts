// @vitest-environment node
import { INIT_SQL } from '../../server/utils/db'
import { DatabaseSync } from 'node:sqlite'
import { getTableName, is, SQL } from 'drizzle-orm'
import type { SQLiteColumn} from 'drizzle-orm/sqlite-core';
import { SQLiteSyncDialect, SQLiteTable, getTableConfig } from 'drizzle-orm/sqlite-core'
import { describe, expect, it } from 'vitest'
import * as declared from '../../drizzle/schema'

/**
 * `drizzle/schema.ts` and the migration SQL are written separately, and the runtime only
 * ever runs the SQL. This keeps them saying the same thing, table by table.
 */
/** The full-text index and SQLite's shadow tables behind it have no Drizzle form. */
const FTS = /^message_search(_(config|content|data|docsize|idx))?$/u

const sqlite = new DatabaseSync(':memory:')
sqlite.exec(INIT_SQL)

const tables = new Map(Object.values(declared)
  .filter((value): value is SQLiteTable => is(value, SQLiteTable))
  .map(table => [getTableName(table), getTableConfig(table)]))
const baselineTables = (sqlite.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`).all() as { name: string }[])
  .map(row => row.name).filter(name => !FTS.test(name)).sort()

const pragma = <T>(sql: string) => sqlite.prepare(sql).all() as T[]
const dialect = new SQLiteSyncDialect()

/** Quoting, spacing, case and a table prefix are not differences. */
const normalize = (value: string) => value.replace(/["`'()\s]|\bdesc\b/giu, '').toLowerCase()
const sqlText = (value: SQL, table: string) => normalize(dialect.sqlToQuery(value).sql).replaceAll(`${table}.`, '')

/** A declared default, in the form PRAGMA table_info reports it. */
function defaultOf(column: SQLiteColumn): string | null {
  const value = column.default
  if (!column.hasDefault || value === undefined) return null
  if (is(value, SQL)) return sqlText(value, '')
  if (typeof value === 'boolean') return value ? '1' : '0'
  return normalize(String(value))
}
const baselineDefault = (value: string | null) => {
  if (value === null) return null
  const text = normalize(value)
  return text === 'true' ? '1' : text === 'false' ? '0' : text
}

type TableInfo = { name: string, type: string, notnull: number, dflt_value: string | null, pk: number }
type ForeignKey = { table: string, from: string, to: string | null, on_update: string, on_delete: string, id: number, seq: number }
type IndexRow = { name: string, unique: number, origin: string, partial: number }
type IndexColumn = { seqno: number, cid: number, name: string | null, key: number }

function baselineColumns(table: string) {
  return Object.fromEntries(pragma<TableInfo>(`PRAGMA table_info(${table})`).map(column => [column.name, {
    type: column.type.toLowerCase(),
    // SQLite never treats a primary key column as nullable in practice; only the rest is compared.
    notNull: column.pk ? null : Boolean(column.notnull),
    default: baselineDefault(column.dflt_value),
  }]))
}
function declaredColumns(table: string) {
  return Object.fromEntries(tables.get(table)!.columns.map(column => [column.name, {
    type: column.getSQLType().toLowerCase(),
    notNull: column.primary || isComposite(table, column.name) ? null : column.notNull,
    default: defaultOf(column),
  }]))
}
const isComposite = (table: string, column: string) => tables.get(table)!.primaryKeys.some(key => key.columns.some(item => item.name === column))

function baselinePrimaryKey(table: string) {
  return pragma<TableInfo>(`PRAGMA table_info(${table})`).filter(column => column.pk).sort((a, b) => a.pk - b.pk).map(column => column.name)
}
function declaredPrimaryKey(table: string) {
  const config = tables.get(table)!
  return config.primaryKeys[0]?.columns.map(column => column.name) ?? config.columns.filter(column => column.primary).map(column => column.name)
}

const foreignKeyKey = (from: string[], target: string, to: (string | null)[], onDelete: string, onUpdate: string) =>
  `${from.join(',')} -> ${target}(${to.join(',')}) delete:${onDelete.toLowerCase()} update:${onUpdate.toLowerCase()}`
function baselineForeignKeys(table: string) {
  const byId = new Map<number, ForeignKey[]>()
  for (const row of pragma<ForeignKey>(`PRAGMA foreign_key_list(${table})`)) byId.set(row.id, [...byId.get(row.id) ?? [], row])
  return [...byId.values()].map((rows) => {
    const sorted = rows.sort((a, b) => a.seq - b.seq)
    return foreignKeyKey(sorted.map(row => row.from), sorted[0]!.table, sorted.map(row => row.to), sorted[0]!.on_delete, sorted[0]!.on_update)
  }).sort()
}
function declaredForeignKeys(table: string) {
  return tables.get(table)!.foreignKeys.map((key) => {
    const reference = key.reference()
    return foreignKeyKey(reference.columns.map(column => column.name), getTableName(reference.foreignTable), reference.foreignColumns.map(column => column.name), key.onDelete ?? 'no action', key.onUpdate ?? 'no action')
  }).sort()
}

/** Every index, unique constraint and UNIQUE column, by what it covers. Generated names are not compared. */
function baselineIndexes(table: string) {
  const definitions = pragma<{ name: string, sql: string | null }>(`SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = '${table}'`)
  return pragma<IndexRow>(`PRAGMA index_list(${table})`).filter(row => row.origin !== 'pk').map((row) => {
    const sql = definitions.find(item => item.name === row.name)?.sql ?? ''
    const columns = pragma<IndexColumn>(`PRAGMA index_info(${row.name})`).sort((a, b) => a.seqno - b.seqno).map(column => column.name)
    const on = columns.includes(null) ? normalize(sql.slice(sql.indexOf('(') + 1, sql.lastIndexOf(')'))) : columns.join(',')
    const where = row.partial ? normalize(sql.slice(sql.search(/\bwhere\b/iu) + 'where'.length)).replaceAll(`${table}.`, '') : ''
    return `${row.unique ? 'unique' : 'index'} ${row.origin === 'c' ? row.name : ''} on ${on}${where ? ` where ${where}` : ''}`.toLowerCase()
  }).sort()
}
function declaredIndexes(table: string) {
  const config = tables.get(table)!
  const autoNamed = new Set(baselineAutoIndexColumns(table))
  const named = (name: string, columns: string) => autoNamed.has(columns) ? '' : name
  return [
    ...config.indexes.map((index) => {
      const on = index.config.columns.map(column => is(column, SQL) ? sqlText(column, table) : (column as SQLiteColumn).name).join(',')
      const where = index.config.where ? sqlText(index.config.where, table) : ''
      return `${index.config.unique ? 'unique' : 'index'} ${index.config.name} on ${on}${where ? ` where ${where}` : ''}`.toLowerCase()
    }),
    ...config.columns.filter(column => column.isUnique).map(column => `unique ${named(column.uniqueName!, column.name)} on ${column.name}`.toLowerCase()),
    ...config.uniqueConstraints.map((constraint) => {
      const columns = constraint.columns.map(column => column.name).join(',')
      return `unique ${named(constraint.name ?? '', columns)} on ${columns}`.toLowerCase()
    }),
  ].sort()
}
/** Constraints written inline in CREATE TABLE have no name of their own in SQLite. */
function baselineAutoIndexColumns(table: string) {
  return pragma<IndexRow>(`PRAGMA index_list(${table})`).filter(row => row.origin === 'u')
    .map(row => pragma<IndexColumn>(`PRAGMA index_info(${row.name})`).sort((a, b) => a.seqno - b.seqno).map(column => column.name).join(','))
}

const checkCount = (table: string) => {
  const row = sqlite.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table) as { sql: string }
  return row.sql.match(/\bCHECK\s*\(/giu)?.length ?? 0
}

describe('drizzle/schema.ts matches the baseline', () => {
  it('declares every table, and none the migrated schema lacks', () => {
    expect([...tables.keys()].sort()).toEqual(baselineTables)
  })

  describe.each(baselineTables)('%s', (table) => {
    it('has the same columns, types, defaults and not-null rules', () => {
      expect(declaredColumns(table)).toEqual(baselineColumns(table))
    })
    it('has the same primary key', () => {
      expect(declaredPrimaryKey(table)).toEqual(baselinePrimaryKey(table))
    })
    it('has the same foreign keys', () => {
      expect(declaredForeignKeys(table)).toEqual(baselineForeignKeys(table))
    })
    it('has the same indexes and unique constraints', () => {
      expect(declaredIndexes(table)).toEqual(baselineIndexes(table))
    })
    it('has the same number of checks', () => {
      expect(tables.get(table)!.checks.length).toBe(checkCount(table))
    })
  })
})
