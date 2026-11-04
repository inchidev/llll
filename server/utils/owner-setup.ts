import type { D1Database } from '@cloudflare/workers-types'
import { isUsername } from '../../shared/account'
import { readServerSetting, sha256Hex } from '../../shared/server-settings'
import type { L4Env } from '../../workers/env'

export type OwnerSetup = {
  /** A suggestion for the setup form. The Owner chooses their own username. */
  username: string | null
  token?: string
  tokenHash?: string
  serverName: string
}

function suggestedUsername(value: string | null | undefined): string | null {
  const username = value?.trim().toLowerCase() || ''
  return isUsername(username) ? username : null
}

export function readOwnerSetupEnv(
  env: Pick<L4Env, 'ADMIN_USERNAME' | 'SETUP_TOKEN' | 'ADMIN_SERVER'>,
  initialName?: string | null,
): OwnerSetup | null {
  const token = env.SETUP_TOKEN?.trim() || ''
  if (token.length < 32) return null
  return {
    username: suggestedUsername(env.ADMIN_USERNAME),
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

/**
 * Read the one pending owner claim from D1, falling back to deployment env once.
 * `persist: false` keeps the read side-effect free (public health).
 */
export async function readOwnerSetup(
  db: D1Database,
  env: Pick<L4Env, 'ADMIN_USERNAME' | 'SETUP_TOKEN' | 'ADMIN_SERVER'>,
  options: { persist?: boolean } = {},
): Promise<OwnerSetup | null> {
  const row = await db
    .prepare('SELECT username, token_hash, server_name FROM server_setup WHERE singleton = 1')
    .first<{ username: string | null; token_hash: string; server_name: string }>()
  if (row) return { username: row.username, tokenHash: row.token_hash, serverName: row.server_name }
  if (await db.prepare('SELECT 1 FROM server LIMIT 1').first()) return null
  const fromEnv = readOwnerSetupEnv(env, await readServerSetting(db, 'initial_name'))
  if (!fromEnv) return null
  if (options.persist !== false) await ensureOwnerSetup(db, fromEnv)
  return fromEnv
}

export async function ensureOwnerSetup(db: D1Database, setup: OwnerSetup): Promise<void> {
  if (!setup.token && !setup.tokenHash) return
  const tokenHash = setup.tokenHash || await sha256Hex(setup.token!)
  const now = new Date().toISOString()
  await db.prepare(
    `INSERT INTO server_setup (singleton, username, token_hash, server_name, created_at, updated_at)
     VALUES (1, ?, ?, ?, ?, ?)
     ON CONFLICT(singleton) DO NOTHING`,
  ).bind(suggestedUsername(setup.username), tokenHash, setup.serverName.slice(0, 80), now, now).run()
}

export async function verifyOwnerSetupToken(setup: OwnerSetup | null, token: string): Promise<boolean> {
  if (!setup) return false
  const expected = setup.tokenHash || (setup.token ? await sha256Hex(setup.token) : '')
  if (!expected) return false
  return ownerSetupTokenMatches(expected, await sha256Hex(token))
}
