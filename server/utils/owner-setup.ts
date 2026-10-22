import type { D1Database } from '@cloudflare/workers-types'
import { readServerSetting, sha256Hex } from '../../shared/server-settings'
import type { L4Env } from '../../workers/env'

export type OwnerSetup = {
  email: string
  token?: string
  tokenHash?: string
  serverName: string
}

export function readOwnerSetupEnv(
  env: Pick<L4Env, 'ADMIN_EMAIL' | 'SETUP_TOKEN' | 'ADMIN_SERVER'>,
  initialName?: string | null,
): OwnerSetup | null {
  const email = env.ADMIN_EMAIL?.trim().toLowerCase() || ''
  const token = env.SETUP_TOKEN?.trim() || ''
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || token.length < 32) return null
  return {
    email,
    token,
    serverName: (env.ADMIN_SERVER?.trim() || initialName?.trim() || 'L4').slice(0, 80),
  }
}

export function ownerSetupTokenMatches(expected: string, actual: string): boolean {
  const encoder = new TextEncoder()
  const left = encoder.encode(expected)
  const right = encoder.encode(actual)
  let mismatch = left.length ^ right.length
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index += 1) mismatch |= (left[index] ?? 0) ^ (right[index] ?? 0)
  return mismatch === 0
}

export function verifiedOwnerSetupEmail(setup: OwnerSetup | null, token: string): string | null {
  if (!setup?.token || !ownerSetupTokenMatches(setup.token, token)) return null
  return setup.email
}

export function maskedOwnerEmail(email: string): string {
  const [local = '', domain = ''] = email.split('@')
  const visible = local.slice(0, 1)
  return `${visible}${'*'.repeat(Math.max(2, Math.min(6, local.length - 1)))}@${domain}`
}

const setupEmail = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

/** Read the one pending owner claim from D1, falling back to legacy env once. */
export async function readOwnerSetup(
  db: D1Database,
  env: Pick<L4Env, 'ADMIN_EMAIL' | 'SETUP_TOKEN' | 'ADMIN_SERVER'>,
): Promise<OwnerSetup | null> {
  const row = await db
    .prepare('SELECT email, token_hash, server_name FROM server_setup WHERE singleton = 1')
    .first<{ email: string; token_hash: string; server_name: string }>()
  if (row) return { email: row.email, tokenHash: row.token_hash, serverName: row.server_name }
  if (await db.prepare('SELECT 1 FROM server LIMIT 1').first()) return null
  const legacy = readOwnerSetupEnv(env, await readServerSetting(db, 'initial_name'))
  if (!legacy) return null
  await ensureOwnerSetupFromEnv(db, legacy)
  return legacy
}

export async function ensureOwnerSetup(db: D1Database, setup: OwnerSetup): Promise<void> {
  const email = setup.email.trim().toLowerCase()
  if (!setupEmail.test(email) || (!setup.token && !setup.tokenHash)) return
  const tokenHash = setup.tokenHash || await sha256Hex(setup.token!)
  const now = new Date().toISOString()
  await db.prepare(
    `INSERT INTO server_setup (singleton, email, token_hash, server_name, created_at, updated_at)
     VALUES (1, ?, ?, ?, ?, ?)
     ON CONFLICT(singleton) DO NOTHING`,
  ).bind(email, tokenHash, setup.serverName.slice(0, 80), now, now).run()
}

async function ensureOwnerSetupFromEnv(
  db: D1Database,
  setup: OwnerSetup,
): Promise<void> {
  await ensureOwnerSetup(db, setup)
}

export async function verifyOwnerSetupToken(setup: OwnerSetup | null, token: string): Promise<string | null> {
  if (!setup) return null
  const expected = setup.tokenHash || (setup.token ? await sha256Hex(setup.token) : '')
  if (!expected) return null
  const actual = await sha256Hex(token)
  return ownerSetupTokenMatches(expected, actual) ? setup.email : null
}
