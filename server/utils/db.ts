/// <reference types="@cloudflare/workers-types" />
import { drizzle } from 'drizzle-orm/d1'
import baselineSql from '../../drizzle/migrations/0000_server_baseline.sql?raw'
import standaloneSql from '../../drizzle/migrations/0001_standalone_server.sql?raw'
import { schema } from '../../drizzle/schema'

export function getDb(d1: D1Database) {
  return drizzle(d1, { schema })
}

/** Convert Drizzle's migration markers into the format accepted by D1 exec. */
export function d1ExecSql(sql: string): string {
  return sql
    .split('--> statement-breakpoint')
    .map(statement => statement
      .split('\n')
      .filter(line => !line.trimStart().startsWith('--'))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim())
    .filter(Boolean)
    .map(statement => statement.endsWith(';') ? statement : `${statement};`)
    .join('\n')
}

export const INIT_SQL = d1ExecSql([
  baselineSql,
  standaloneSql,
].join('\n--> statement-breakpoint\n'))

/** Bootstrap is only for an empty database. Deployed changes use D1 migrations. */
// An isolate serves one Server, so a schema that was present once stays
// present for the isolate's lifetime. Skipping the probes saves three D1 round
// trips on every public request.
const migratedDatabases = new WeakSet<D1Database>()

function celldRuntime(env?: { LLLL_RUNTIME?: string }): boolean {
  return env?.LLLL_RUNTIME?.trim().toLowerCase() === 'celld'
}

export async function ensureMigrated(db: D1Database, env?: { LLLL_RUNTIME?: string }): Promise<boolean> {
  if (migratedDatabases.has(db)) return true
  // celld records schema in d1_migrations. Applying INIT_SQL here creates the
  // same tables without that bookkeeping, and `celld d1 migrations apply` then
  // stops on "table already exists".
  if (!celldRuntime(env)) {
    try {
      await db.prepare('SELECT id FROM workspace LIMIT 1').first()
    }
    catch {
      await db.exec(INIT_SQL)
    }
  }
  await Promise.all([
    db.prepare('SELECT kind FROM users LIMIT 1').first(),
    db.prepare('SELECT user_id FROM agents LIMIT 1').first(),
  ])
  migratedDatabases.add(db)
  return true
}

export async function userCount(db: D1Database): Promise<number> {
  try {
    const row = await db.prepare("SELECT COUNT(*) as c FROM users WHERE status = 'active'").first<{ c: number }>()
    return row?.c ?? 0
  }
  catch {
    return 0
  }
}

export async function workspaceReady(db: D1Database): Promise<boolean> {
  try {
    return Boolean(await db.prepare("SELECT id FROM workspace LIMIT 1").first())
  }
  catch {
    return false
  }
}
