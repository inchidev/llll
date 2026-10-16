import { createError } from '@llll/admin-core'
import { audit, ensureSchema, nowIso } from './db'
import { hashPassword, sha256, verifyPassword } from './secrets'

const COUNT = 10
const WINDOW = 15 * 60 * 1000

function fail(statusCode: number, statusMessage: string): never {
  throw createError({ statusCode, statusMessage })
}

function normalize(code: string) {
  return code.trim().replace(/[\s-]/gu, '').toLowerCase()
}

async function digest(ownerId: string, code: string) {
  return sha256(`admin-recovery:${ownerId}:${normalize(code)}`)
}

/** Plaintext is returned once, never stored or written to the audit log. */
export async function generateRecoveryCodes(db: D1Database, ownerId: string, expectedPasswordHash?: string) {
  await ensureSchema(db)
  const codes = Array.from({ length: COUNT }, () => {
    const bytes = crypto.getRandomValues(new Uint8Array(16))
    const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
    return hex.match(/.{8}/gu)!.join('-')
  })
  const hashes = await Promise.all(codes.map(code => digest(ownerId, code)))
  const guard = 'EXISTS (SELECT 1 FROM owners WHERE id = ? AND password_hash = ?)'
  const results = await db.batch([
    expectedPasswordHash
      ? db.prepare(`DELETE FROM recovery_codes WHERE owner_id = ? AND ${guard}`).bind(ownerId, ownerId, expectedPasswordHash)
      : db.prepare('DELETE FROM recovery_codes WHERE owner_id = ?').bind(ownerId),
    ...hashes.map(hash => expectedPasswordHash
      ? db.prepare(`INSERT INTO recovery_codes (code_hash, owner_id, created_at) SELECT ?, ?, ? WHERE ${guard}`).bind(hash, ownerId, nowIso(), ownerId, expectedPasswordHash)
      : db.prepare('INSERT INTO recovery_codes (code_hash, owner_id, created_at) VALUES (?, ?, ?)').bind(hash, ownerId, nowIso())),
  ])
  if (results.at(-1)?.meta.changes !== 1) fail(401, 'Password changed. Sign in again before generating recovery codes')
  await audit(db, 'owner.recovery_codes.rotate', ownerId)
  return codes
}

export async function recoveryCodeCount(db: D1Database, ownerId: string) {
  await ensureSchema(db)
  const row = await db.prepare('SELECT COUNT(*) AS remaining FROM recovery_codes WHERE owner_id = ? AND used_at IS NULL').bind(ownerId).first<{ remaining: number }>()
  return row?.remaining ?? 0
}

export async function rotateRecoveryCodes(db: D1Database, ownerId: string, password: unknown) {
  await ensureSchema(db)
  const owner = await db.prepare('SELECT password_hash AS hash FROM owners WHERE id = ?').bind(ownerId).first<{ hash: string }>()
  if (typeof password !== 'string' || password.length > 256 || !owner || !await verifyPassword(password, owner.hash)) fail(401, 'Current password is incorrect')
  return generateRecoveryCodes(db, ownerId, owner.hash)
}

/** Persistent, bounded IP buckets also limit requests reaching PBKDF2. */
export async function limitRecovery(db: D1Database, source: string) {
  await ensureSchema(db)
  const now = Date.now()
  const key = await sha256(`admin-recovery-ip:${source}`)
  await db.prepare('DELETE FROM recovery_attempts WHERE expires_at <= ?').bind(now).run()
  const row = await db.prepare(`INSERT INTO recovery_attempts (key, attempts, expires_at) VALUES (?, 1, ?)
    ON CONFLICT(key) DO UPDATE SET attempts = attempts + 1
    RETURNING attempts`).bind(key, now + WINDOW).first<{ attempts: number }>()
  if (!row || row.attempts > 5) fail(429, 'Too many recovery attempts. Try again in 15 minutes')
}

export async function recoverPassword(db: D1Database, body: { email?: unknown, code?: unknown, password?: unknown }) {
  await ensureSchema(db)
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
  const code = typeof body.code === 'string' ? normalize(body.code) : ''
  const password = typeof body.password === 'string' ? body.password : ''
  if (password.length < 12 || password.length > 256) fail(400, 'Use a password of at least 12 characters')
  const owner = await db.prepare('SELECT id FROM owners WHERE email = ?').bind(email).first<{ id: string }>()
  if (!owner || !/^[0-9a-f]{32}$/u.test(code)) fail(401, 'Email or recovery code is incorrect')
  const hash = await digest(owner.id, code)
  const match = await db.prepare('SELECT code_hash FROM recovery_codes WHERE code_hash = ? AND owner_id = ? AND used_at IS NULL').bind(hash, owner.id).first()
  if (!match) fail(401, 'Email or recovery code is incorrect')
  const passwordHash = await hashPassword(password)
  const nonce = crypto.randomUUID()
  // D1 batch is a transaction. Every subsequent write is guarded by this
  // unique consumption marker, so only one concurrent request can succeed.
  const guard = 'EXISTS (SELECT 1 FROM recovery_codes WHERE code_hash = ? AND owner_id = ? AND used_at = ?)'
  const result = await db.batch([
    db.prepare('UPDATE recovery_codes SET used_at = ? WHERE code_hash = ? AND owner_id = ? AND used_at IS NULL').bind(nonce, hash, owner.id),
    db.prepare(`UPDATE owners SET password_hash = ?, updated_at = ? WHERE id = ? AND ${guard}`).bind(passwordHash, nowIso(), owner.id, hash, owner.id, nonce),
    db.prepare(`DELETE FROM sessions WHERE owner_id = ? AND ${guard}`).bind(owner.id, hash, owner.id, nonce),
    db.prepare(`INSERT INTO audit (id, at, action, target) SELECT ?, ?, 'owner.password.recover', ? WHERE ${guard}`).bind(crypto.randomUUID(), nowIso(), owner.id, hash, owner.id, nonce),
  ])
  if (result[0]?.meta.changes !== 1) fail(401, 'Email or recovery code is incorrect')
  return { recovered: true }
}
