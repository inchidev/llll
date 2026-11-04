import { and, eq, isNull } from 'drizzle-orm'
import { authAccounts, authUsers } from '../../drizzle/schema'
import { isUsername, normalizeUsername, usernameFrom } from '../../shared/account'
import type { getDb } from './db'

/**
 * Better Auth needs a unique, non-null email on every user. An Account with no email
 * holds an address in this reserved domain instead. It is never verified, so it can
 * never sign in, reset a password or receive mail, and it never leaves the Server.
 * `.invalid` cannot be registered or delivered to (RFC 2606).
 */
const NO_EMAIL_DOMAIN = '@no-email.invalid'

export function placeholderEmail(id: string = crypto.randomUUID()): string {
  return `${id}${NO_EMAIL_DOMAIN}`
}

export function isPlaceholderEmail(email: string): boolean {
  return email.endsWith(NO_EMAIL_DOMAIN)
}

/** The Account id a placeholder was made for. */
export function placeholderId(email: string): string | null {
  return isPlaceholderEmail(email) ? email.slice(0, -NO_EMAIL_DOMAIN.length) : null
}

/** The address to show: never the placeholder. */
export function accountEmail(row: { email: string }): string | null {
  return isPlaceholderEmail(row.email) ? null : row.email
}

/** The address that counts for sign-in, reset and mail. */
export function verifiedEmail(row: { email: string; emailVerified: boolean }): string | null {
  return row.emailVerified ? accountEmail(row) : null
}

export type LoginAccount = { id: string; email: string; emailVerified: boolean; username: string }

const loginAccountColumns = { id: authUsers.id, email: authUsers.email, emailVerified: authUsers.emailVerified, username: authUsers.username }

/** The Account an address is verified on. Unverified, pending and placeholder addresses match nothing. */
export async function findAccountByVerifiedEmail(db: ReturnType<typeof getDb>, email: string): Promise<LoginAccount | null> {
  const value = email.trim().toLowerCase()
  return (await db.select(loginAccountColumns).from(authUsers).where(and(eq(authUsers.email, value), eq(authUsers.emailVerified, true))).limit(1))[0] ?? null
}

/**
 * Recovery and password reset name an Account by username or verified email. Signing in
 * uses Better Auth's username plugin; it has no lookup for these two. Usernames cannot
 * contain `@`, so the two kinds of value never overlap. Nothing is merged by email here.
 */
export async function findAccountByLogin(db: ReturnType<typeof getDb>, login: string): Promise<LoginAccount | null> {
  const value = login.trim().toLowerCase()
  if (value.includes('@')) return findAccountByVerifiedEmail(db, value)
  return (await db.select(loginAccountColumns).from(authUsers).where(eq(authUsers.username, normalizeUsername(value))).limit(1))[0] ?? null
}

/** A well-formed username nobody holds, for sign-in values that name no Account. */
export function unknownUsername(): string {
  return crypto.randomUUID().replaceAll('-', '')
}

/** An Account with a username but no password, as a provider or Cloudflare Access makes. */
export async function isPasswordlessAccount(db: ReturnType<typeof getDb>, username: string): Promise<boolean> {
  const row = (await db.select({ password: authAccounts.password }).from(authUsers)
    .leftJoin(authAccounts, and(eq(authAccounts.userId, authUsers.id), eq(authAccounts.providerId, 'credential')))
    .where(and(eq(authUsers.username, normalizeUsername(username)), isNull(authAccounts.password))).limit(1))[0]
  return Boolean(row)
}

/** A free username for an Account that did not choose one (social, Cloudflare Access). They can change it. */
export async function generatedUsername(db: ReturnType<typeof getDb>, seed: string | null | undefined): Promise<string> {
  const base = usernameFrom(seed)
  const taken = async (candidate: string) => Boolean((await db.select({ id: authUsers.id }).from(authUsers).where(eq(authUsers.username, candidate)).limit(1))[0])
  if (isUsername(base) && !await taken(base)) return base
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate = `${base.slice(0, 24)}-${crypto.randomUUID().slice(0, 6)}`
    if (isUsername(candidate) && !await taken(candidate)) return candidate
  }
  return `member-${crypto.randomUUID().slice(0, 12)}`
}

/** The username plugin's refusal, or a D1 unique failure when two people raced past it, however Drizzle wraps it. */
export function isUsernameConflict(error: unknown): boolean {
  if ((error as { body?: { code?: unknown } } | null)?.body?.code === 'USERNAME_IS_ALREADY_TAKEN') return true
  for (let current = error; current; current = (current as { cause?: unknown }).cause) {
    if (String((current as { message?: unknown }).message ?? current).includes('auth_users.username')) return true
  }
  return false
}

/** Removes placeholder addresses from what Better Auth's own endpoints return, such as `get-session`. */
export async function hidePlaceholderEmails(response: Response): Promise<Response> {
  if (!response.headers.get('content-type')?.includes('json')) return response
  const text = await response.clone().text()
  if (!text.includes(NO_EMAIL_DOMAIN)) return response
  const body = JSON.stringify(JSON.parse(text), (_key, value: unknown) => typeof value === 'string' && isPlaceholderEmail(value) ? null : value)
  const headers = new Headers(response.headers)
  headers.delete('content-length')
  return new Response(body, { status: response.status, statusText: response.statusText, headers })
}
