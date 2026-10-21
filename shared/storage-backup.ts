import { createTarStream, sqlIdentifier, sqlInsertStatements, textEntry, type TarEntry } from '../server/utils/backup-format'
type DatabaseStatement = {
  bind(...values: (string | number)[]): DatabaseStatement
  all<Row = Record<string, unknown>>(): Promise<{ results: Row[] }>
}
type DatabaseSession = { prepare(sql: string): DatabaseStatement }
type BackupDatabase = { withSession(bookmark: string): DatabaseSession }
type ByteStream = { getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(reason?: unknown): Promise<void>; releaseLock(): void } }
type BackupFiles = {
  list(options: { limit: number; cursor?: string; include: ('httpMetadata' | 'customMetadata')[] }): Promise<{ objects: { key: string; size: number; etag: string; uploaded: Date; storageClass?: string; httpMetadata?: unknown; customMetadata?: unknown }[]; truncated: boolean; cursor?: string }>
  get(key: string, options: { onlyIf: { etagMatches: string } }): Promise<{ key: string; body?: ByteStream } | null>
}
function portableStream(stream: ByteStream) {
  const reader = stream.getReader()
  return new ReadableStream<Uint8Array>({
    async pull(controller) { const next = await reader.read(); if (next.done) { reader.releaseLock(); controller.close() } else if (next.value) controller.enqueue(next.value) },
    async cancel(reason) { await reader.cancel(reason); reader.releaseLock() },
  })
}

type SchemaRow = {
  type: 'table' | 'index' | 'trigger' | 'view'
  name: string
  tableName: string
  sql: string
}

type TableColumn = { name: string }
type TableListRow = { name: string, type: string }

const DATABASE_PAGE_ROWS = 10

function statement(value: string) {
  const sql = value.trim()
  return sql.endsWith(';') ? sql : `${sql};`
}

function sqlPage(table: string, columns: string[], rows: Record<string, unknown>[]) {
  const inserts = rows.flatMap(row => sqlInsertStatements(table, columns, row))
  return `${inserts.join('\n')}\n`
}

function backupReadme(createdAt: string, version: string) {
  return `L4 manual backup

Created: ${createdAt}
L4 version: ${version}

Contents
- manifest.json describes the archive format.
- database/*.sql is a logical D1 export. Concatenate the fragments in filename order into one restore.sql, then import that entire file into an empty D1 database. Do not import fragments separately: foreign-key checks must stay deferred until all related rows are restored.
  Example: cat database/*.sql > restore.sql
  Import: npx wrangler d1 execute <database-name> --remote --file=restore.sql
- r2/*.json stores metadata for the adjacent numbered .bin object. The JSON field "key" is the original R2 key.
- summary.json is written last and records the completed table, row, and R2 object counts. If it is missing, discard the incomplete archive.

Security
This archive contains server messages, authentication records, and attachment bytes. Store it as sensitive data. Environment secrets such as AUTH_SECRET are not included and must be preserved separately.

Scope
Durable Object live state, KV tickets, running Agent turns, and external RealtimeKit data are not included. Keep the server idle while downloading for the most consistent snapshot.
`
}

async function schemaRows(database: DatabaseSession): Promise<SchemaRow[]> {
  const [schema, tableList] = await Promise.all([
    database.prepare(
      `SELECT type, name, tbl_name AS tableName, sql
       FROM sqlite_master
       WHERE type IN ('table', 'index', 'trigger', 'view')
         AND name NOT LIKE 'sqlite_%'
         AND sql IS NOT NULL
       ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 WHEN 'trigger' THEN 2 ELSE 3 END, name`,
    ).all<SchemaRow>(),
    database.prepare('PRAGMA table_list').all<TableListRow>(),
  ])
  const shadowTables = new Set((tableList.results ?? [])
    .filter(table => table.type === 'shadow')
    .map(table => table.name))
  return (schema.results ?? []).filter(item => !item.name.startsWith('_cf_') && !item.tableName.startsWith('_cf_')
    && !shadowTables.has(item.name) && !shadowTables.has(item.tableName))
}

async function tableColumns(database: DatabaseSession, table: string) {
  const result = await database.prepare(`PRAGMA table_info(${sqlIdentifier(table)})`).all<TableColumn>()
  return (result.results ?? []).map(column => column.name)
}

async function* backupEntries(env: { DB: BackupDatabase; FILES?: BackupFiles }, createdAt: string, version: string): AsyncGenerator<TarEntry> {
  const modifiedAt = new Date(createdAt)
  const database = env.DB.withSession('first-primary')
  const schema = await schemaRows(database)
  const tables = schema.filter(item => item.type === 'table')
  // Foreign keys can reference UNIQUE alternate keys (OAuth client/resource IDs).
  // SQLite needs those indexes when preparing inserts, even with deferred checks.
  const uniqueIndexes = schema.filter(item => item.type === 'index' && /^\s*CREATE\s+UNIQUE\s+INDEX\b/iu.test(item.sql))
  const earlyIndexes = new Set(uniqueIndexes.map(item => item.name))
  const deferred = schema.filter(item => item.type !== 'table' && !earlyIndexes.has(item.name))
  let databaseRows = 0
  let r2Objects = 0
  let r2Bytes = 0

  yield textEntry('README.txt', backupReadme(createdAt, version), modifiedAt)
  yield textEntry('manifest.json', `${JSON.stringify({
    schemaVersion: 1,
    product: 'llll',
    llllVersion: version,
    createdAt,
    database: { format: 'ordered-sql-fragments-v1', path: 'database/' },
    r2: { format: 'numbered-object-pairs-v1', path: 'r2/' },
  }, null, 2)}\n`, modifiedAt)

  const tableSchema = [...tables, ...uniqueIndexes].map(item => statement(item.sql)).join('\n\n')
  yield textEntry('database/000000-schema.sql', `PRAGMA defer_foreign_keys=ON;\n${tableSchema}\n`, modifiedAt)

  for (let tableIndex = 0; tableIndex < tables.length; tableIndex += 1) {
    const table = tables[tableIndex]!
    const columns = await tableColumns(database, table.name)
    if (!columns.length) continue
    let offset = 0
    let page = 0
    while (true) {
      const result = await database.prepare(
        `SELECT * FROM ${sqlIdentifier(table.name)} LIMIT ? OFFSET ?`,
      ).bind(DATABASE_PAGE_ROWS, offset).all<Record<string, unknown>>()
      const rows = result.results ?? []
      if (!rows.length) break
      page += 1
      databaseRows += rows.length
      const path = `database/${String(tableIndex + 1).padStart(6, '0')}-${String(page).padStart(6, '0')}.sql`
      yield textEntry(path, sqlPage(table.name, columns, rows), modifiedAt)
      offset += rows.length
      if (rows.length < DATABASE_PAGE_ROWS) break
    }
  }

  const deferredSchema = deferred.map(item => statement(item.sql)).join('\n\n')
  yield textEntry('database/999999-indexes.sql', `${deferredSchema}\n`, modifiedAt)

  let cursor: string | undefined
  if (env.FILES) do {
    const listed = await env.FILES.list({
      limit: 1000,
      cursor,
      include: ['httpMetadata', 'customMetadata'],
    })
    for (const object of listed.objects) {
      r2Objects += 1
      r2Bytes += object.size
      const sequence = String(r2Objects).padStart(8, '0')
      const metadata = {
        key: object.key,
        size: object.size,
        etag: object.etag,
        uploadedAt: object.uploaded.toISOString(),
        storageClass: object.storageClass,
        httpMetadata: object.httpMetadata,
        customMetadata: object.customMetadata,
      }
      yield textEntry(`r2/${sequence}.json`, `${JSON.stringify(metadata, null, 2)}\n`, modifiedAt)

      const body = await env.FILES.get(object.key, { onlyIf: { etagMatches: object.etag } })
      if (!body?.body) throw new Error(`R2 object changed while backing up: ${object.key}`)
      yield {
        path: `r2/${sequence}.bin`,
        size: object.size,
        modifiedAt: object.uploaded,
        body: portableStream(body.body),
      }
    }
    cursor = listed.truncated ? listed.cursor : undefined
  } while (cursor)

  yield textEntry('summary.json', `${JSON.stringify({
    completedAt: new Date().toISOString(),
    tables: tables.length,
    databaseRows,
    r2Objects,
    r2Bytes,
  }, null, 2)}\n`, new Date())
}

export function createStorageBackup(database: BackupDatabase, files: BackupFiles | undefined, createdAt: string, version: string) {
  return createTarStream(backupEntries({ DB: database, FILES: files }, createdAt, version))
}
