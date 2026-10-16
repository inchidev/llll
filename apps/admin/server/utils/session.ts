import type { H3Event } from 'h3'
import type { AdminEnv } from '../env'
import { ensureSchema, nowIso, readMeta, writeMeta, audit } from './db'
import { adminEnv, fail } from './http'
import { generateRecoveryCodes } from './recovery'
import { hashPassword, randomToken, sameString, sha256, verifyPassword } from './secrets'

const COOKIE = 'llll_admin'
const SESSION_DAYS = 30

export type Owner = { id: string, email: string }

function validCredentials(email: unknown, password: unknown) {
  const address = typeof email === 'string' ? email.trim().toLowerCase() : ''
  const secret = typeof password === 'string' ? password : ''
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/u.test(address) || address.length > 254) fail(400, 'Enter a valid email')
  if (secret.length < 12 || secret.length > 256) fail(400, 'Use a password of at least 12 characters')
  return { email: address, password: secret }
}

async function startSession(event: H3Event, env: AdminEnv, ownerId: string) {
  const token = randomToken(32)
  const expires = new Date(Date.now() + SESSION_DAYS * 86_400_000)
  await env.ADMIN_DB.prepare('INSERT INTO sessions (token_hash, owner_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
    .bind(await sha256(token), ownerId, expires.toISOString(), nowIso()).run()
  setCookie(event, COOKIE, token, { httpOnly: true, secure: true, sameSite: 'lax', path: '/', expires })
}

export async function ownerClaimed(env: AdminEnv): Promise<boolean> {
  await ensureSchema(env.ADMIN_DB)
  return Boolean(await env.ADMIN_DB.prepare('SELECT id FROM owners LIMIT 1').first())
}

/** A claim token is usable once. Setting a new ADMIN_CLAIM_TOKEN secret recovers access. */
async function claimAvailable(env: AdminEnv, token: string): Promise<boolean> {
  const expected = env.ADMIN_CLAIM_TOKEN?.trim()
  if (!expected || !token || !sameString(token, expected)) return false
  return (await readMeta(env.ADMIN_DB, 'claim_used')) !== await sha256(expected)
}

export async function claimOwner(event: H3Event, body: { token?: unknown, email?: unknown, password?: unknown }) {
  const env = adminEnv(event)
  const token = typeof body.token === 'string' ? body.token.trim() : ''
  if (!await claimAvailable(env, token)) fail(401, 'This setup link was already used or is invalid')
  const { email, password } = validCredentials(body.email, body.password)
  const passwordHash = await hashPassword(password)
  const existing = await env.ADMIN_DB.prepare('SELECT id FROM owners LIMIT 1').first<{ id: string }>()
  const id = existing?.id ?? crypto.randomUUID()
  const now = nowIso()
  await env.ADMIN_DB.batch([
    env.ADMIN_DB.prepare('DELETE FROM owners WHERE id <> ?').bind(id),
    env.ADMIN_DB.prepare(
      `INSERT INTO owners (id, email, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET email = excluded.email, password_hash = excluded.password_hash, updated_at = excluded.updated_at`,
    ).bind(id, email, passwordHash, now, now),
    env.ADMIN_DB.prepare('DELETE FROM sessions'),
  ])
  await writeMeta(env.ADMIN_DB, 'claim_used', await sha256(env.ADMIN_CLAIM_TOKEN!.trim()))
  await audit(env.ADMIN_DB, existing ? 'owner.recover' : 'owner.claim', email)
  await startSession(event, env, id)
  const codes = await generateRecoveryCodes(env.ADMIN_DB, id, passwordHash)
  return { email, codes }
}

export async function login(event: H3Event, body: { email?: unknown, password?: unknown }) {
  const env = adminEnv(event)
  await ensureSchema(env.ADMIN_DB)
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
  const password = typeof body.password === 'string' ? body.password : ''
  const owner = await env.ADMIN_DB.prepare('SELECT id, password_hash AS passwordHash FROM owners WHERE email = ?')
    .bind(email).first<{ id: string, passwordHash: string }>()
  // Hash even for an unknown email so response time does not reveal it.
  const valid = await verifyPassword(password, owner?.passwordHash ?? 'pbkdf2$100000$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')
  if (!owner || !valid) fail(401, 'Email or password is incorrect')
  await startSession(event, env, owner.id)
  return { email }
}

export async function logout(event: H3Event) {
  const env = adminEnv(event)
  const token = getCookie(event, COOKIE)
  if (token) await env.ADMIN_DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256(token)).run()
  deleteCookie(event, COOKIE, { path: '/' })
}

export async function currentOwner(event: H3Event): Promise<Owner | null> {
  const env = adminEnv(event)
  await ensureSchema(env.ADMIN_DB)
  const token = getCookie(event, COOKIE)
  if (!token) return null
  return await env.ADMIN_DB.prepare(
    `SELECT o.id, o.email FROM sessions s JOIN owners o ON o.id = s.owner_id
     WHERE s.token_hash = ? AND s.expires_at > ?`,
  ).bind(await sha256(token), nowIso()).first<Owner>()
}

export async function requireOwner(event: H3Event): Promise<Owner> {
  const owner = await currentOwner(event)
  if (!owner) fail(401, 'Sign in to the L4 Admin')
  return owner
}
