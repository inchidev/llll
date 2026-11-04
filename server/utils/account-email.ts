import type { H3Event } from 'h3'
import { bytesToHex, randomBytes } from '@noble/hashes/utils.js'
import { readAppBranding } from '../../shared/app-branding'
import { loadAuthRuntimeConfig } from './auth-config'
import { authRequestContext, sendAuthEmail } from './better-auth'
import { cf } from './cf'
import { recoveryDigest } from './recovery'

const CONFIRM_PREFIX = 'confirm-email:'
const CONFIRM_TTL_MS = 60 * 60 * 1000

/**
 * Stores an address on the Account without trusting it. It stays in `pending_email`, so it
 * cannot sign in, reset a password, or reserve an address someone else really owns, and any
 * verified address keeps working. With mail ready, a single-use link confirms it.
 * Returns whether that link was sent.
 */
export async function addPendingEmail(event: H3Event, userId: string, email: string): Promise<boolean> {
  const { env, waitUntil } = cf(event)
  const { baseURL } = await authRequestContext(event)
  const config = await loadAuthRuntimeConfig(env, baseURL)
  const statements = [
    env.DB.prepare('UPDATE auth_users SET pending_email = ?, updated_at = ? WHERE id = ?').bind(email, Date.now(), userId),
    // Only the newest address can be confirmed.
    env.DB.prepare('DELETE FROM auth_verifications WHERE value = ? AND identifier LIKE ?').bind(userId, `${CONFIRM_PREFIX}%`),
  ]
  if (!config.email.verificationReady) {
    await env.DB.batch(statements)
    return false
  }
  const token = bytesToHex(randomBytes(32))
  const now = Date.now()
  await env.DB.batch([
    ...statements,
    env.DB.prepare('INSERT INTO auth_verifications (id, identifier, value, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(crypto.randomUUID(), CONFIRM_PREFIX + await recoveryDigest(token), userId, now + CONFIRM_TTL_MS, now, now),
  ])
  const appName = readAppBranding().appName
  waitUntil(sendAuthEmail(
    env,
    config.email.from!,
    config.email.fromName,
    email,
    `Verify your ${appName} email`,
    `Verify this email address for your ${appName} account.`,
    'Verify email',
    new URL(`/api/auth/confirm-email?token=${token}`, baseURL).toString(),
  ))
  return true
}

/** Spends a confirmation link. The address becomes the Account's verified email unless another Account already holds it. */
export async function confirmPendingEmail(event: H3Event, token: string): Promise<'confirmed' | 'invalid' | 'taken'> {
  const { env } = cf(event)
  const row = await env.DB.prepare('DELETE FROM auth_verifications WHERE identifier = ? RETURNING value, expires_at')
    .bind(CONFIRM_PREFIX + await recoveryDigest(token))
    .first<{ value: string; expires_at: number }>()
  if (!row || row.expires_at < Date.now()) return 'invalid'
  try {
    const updated = await env.DB.prepare('UPDATE auth_users SET email = pending_email, email_verified = 1, pending_email = NULL, updated_at = ? WHERE id = ? AND pending_email IS NOT NULL')
      .bind(Date.now(), row.value).run()
    return updated.meta.changes ? 'confirmed' : 'invalid'
  }
  catch (error) {
    if (String((error as Error).message).includes('auth_users.email')) return 'taken'
    throw error
  }
}
