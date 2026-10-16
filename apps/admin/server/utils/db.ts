/**
 * The Admin's own D1 database. It holds the owner, the Cloudflare credential,
 * and the infrastructure it created for each workspace. The schema is applied
 * on first use; later changes append statements to SCHEMA.
 */
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS admin_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS owners (
    id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY, owner_id TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS credential (
    id TEXT PRIMARY KEY CHECK (id = 'main'),
    kind TEXT NOT NULL CHECK (kind IN ('oauth', 'token')),
    secret_encrypted TEXT NOT NULL,
    access_encrypted TEXT,
    access_expires_at INTEGER,
    scopes TEXT NOT NULL DEFAULT '',
    problem TEXT,
    updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS oauth_states (nonce TEXT PRIMARY KEY, verifier TEXT NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS app_domains (
    worker_name TEXT PRIMARY KEY, zone_id TEXT NOT NULL, zone_name TEXT NOT NULL, hostname TEXT NOT NULL,
    domain_id TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS email_domains (
    id TEXT PRIMARY KEY, worker_name TEXT NOT NULL, zone_id TEXT NOT NULL, zone_name TEXT NOT NULL, domain TEXT NOT NULL,
    sending_subdomain_id TEXT, sending_enabled INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    UNIQUE (worker_name, domain))`,
  `CREATE TABLE IF NOT EXISTS mailbox_routes (
    worker_name TEXT NOT NULL, email_domain_id TEXT NOT NULL, address TEXT NOT NULL, rule_id TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (worker_name, address))`,
  `CREATE TABLE IF NOT EXISTS live_apps (
    worker_name TEXT PRIMARY KEY, app_id TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS audit (
    id TEXT PRIMARY KEY, at TEXT NOT NULL, action TEXT NOT NULL, target TEXT, detail TEXT)`,
  `CREATE TABLE IF NOT EXISTS recovery_codes (
    code_hash TEXT PRIMARY KEY, owner_id TEXT NOT NULL, used_at TEXT, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS recovery_attempts (
    key TEXT PRIMARY KEY, attempts INTEGER NOT NULL, expires_at INTEGER NOT NULL)`,
]

const schemas = new WeakMap<D1Database, Promise<void>>()

export function ensureSchema(db: D1Database): Promise<void> {
  let ready = schemas.get(db)
  if (!ready) {
    ready = db.batch(SCHEMA.map(sql => db.prepare(sql))).then(() => undefined).catch((error) => {
      schemas.delete(db)
      throw error
    })
    schemas.set(db, ready)
  }
  return ready
}

export function nowIso() {
  return new Date().toISOString()
}

export async function readMeta(db: D1Database, key: string): Promise<string | null> {
  await ensureSchema(db)
  const row = await db.prepare('SELECT value FROM admin_meta WHERE key = ?').bind(key).first<{ value: string }>()
  return row?.value ?? null
}

export async function writeMeta(db: D1Database, key: string, value: string | null): Promise<void> {
  await ensureSchema(db)
  if (value === null) await db.prepare('DELETE FROM admin_meta WHERE key = ?').bind(key).run()
  else await db.prepare('INSERT INTO admin_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(key, value).run()
}

export async function audit(db: D1Database, action: string, target: string | null, detail?: Record<string, unknown>) {
  await ensureSchema(db)
  await db.prepare('INSERT INTO audit (id, at, action, target, detail) VALUES (?, ?, ?, ?, ?)')
    .bind(crypto.randomUUID(), nowIso(), action, target, detail ? JSON.stringify(detail) : null).run()
}
