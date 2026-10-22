import type { D1Database } from '@cloudflare/workers-types'
import { nowIso } from './ids'

export const SERVER_WORKER_NAME = 'worker_name'
export const SERVER_BACKUP_BUCKET = 'backup_bucket'
export const MAIL_DEFAULT_LOCAL_PART = 'mail_default_local_part'

export function isUuidV4(value: unknown): value is string {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
}

export function defaultWorkerName(serverId: string): string {
  return `llll-${serverId}`
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

export async function readServerSetting(db: D1Database, key: string): Promise<string | null> {
  const row = await db.prepare('SELECT value FROM server_settings WHERE key = ?').bind(key).first<{ value: string }>()
  return row?.value ?? null
}

export async function writeServerSetting(db: D1Database, key: string, value: string): Promise<void> {
  await db.prepare(
    `INSERT INTO server_settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).bind(key, value, nowIso()).run()
}
