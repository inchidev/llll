// Local synthetic query benchmark. No production credentials or network access.
import { DatabaseSync } from 'node:sqlite'
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
const root = resolve(import.meta.dirname, '..')
const db = new DatabaseSync(':memory:')
for (const file of readdirSync(resolve(root, 'drizzle/server-migrations')).filter(file => file.endsWith('.sql')).sort()) db.exec(readFileSync(resolve(root, 'drizzle/server-migrations', file), 'utf8'))
db.exec("INSERT INTO users(id,display_name) VALUES('bench','Benchmark'); INSERT INTO database_definitions(id,name,created_by) VALUES('bench','Benchmark','bench')")
const columns = ['title', ...Array.from({ length: 16 }, (_, i) => `text_${i + 1}`)]
const insert = db.prepare(`INSERT INTO database_items(id,database_id,created_by,position,${columns.join(',')}) VALUES(?,?,?,?${',?'.repeat(columns.length)})`)
db.exec('BEGIN')
for (let i = 0; i < 10_000; i++) insert.run(`row-${i}`, 'bench', 'bench', i, `Record ${i}`, ...columns.slice(1).map((_, j) => `Field ${j} value ${i} ${'community research '.repeat(5)}`))
db.exec('COMMIT')
const search = columns.map(column => `lower(CAST(${column} AS TEXT)) LIKE ? ESCAPE '\\'`).join(' OR ')
const queries = {
  count: ["SELECT COUNT(*) FROM database_items WHERE database_id=? AND deleted_at IS NULL", ['bench']],
  page: ["SELECT * FROM database_items WHERE database_id=? AND deleted_at IS NULL ORDER BY position,created_at,id LIMIT 100", ['bench']],
  searchCount: [`SELECT COUNT(*) FROM database_items WHERE database_id=? AND deleted_at IS NULL AND (${search})`, ['bench', ...columns.map(() => '%value 991%')]],
  searchPage: [`SELECT * FROM database_items WHERE database_id=? AND deleted_at IS NULL AND (${search}) ORDER BY position,created_at,id LIMIT 100`, ['bench', ...columns.map(() => '%value 991%')]],
}
function run(label) {
  for (const [name, [sql, values]] of Object.entries(queries)) {
    const statement = db.prepare(sql)
    for (let i = 0; i < 5; i++) statement.all(...values)
    const samples = Array.from({ length: 30 }, () => { const start = performance.now(); statement.all(...values); return performance.now() - start }).sort((a, b) => a - b)
    console.log(JSON.stringify({ label, query: name, medianMs: +samples[15].toFixed(2), p95Ms: +samples[28].toFixed(2), plan: db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...values).map(row => row.detail) }))
  }
}
db.exec('DROP INDEX IF EXISTS database_items_active_position_idx')
run('existing index')
db.exec('CREATE INDEX database_items_active_position_idx ON database_items(database_id,position,created_at,id) WHERE deleted_at IS NULL')
run('covering active order index')
db.close()
