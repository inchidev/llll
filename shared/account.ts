import { z } from 'zod'

export const USERNAME_MIN_LENGTH = 3
export const USERNAME_MAX_LENGTH = 32
/** Letters, digits, dot, underscore, hyphen; starts and ends with a letter or digit. */
const USERNAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{1,30}[a-zA-Z0-9]$/u
export const USERNAME_HELP = 'Use 3 to 32 letters, digits, dots, hyphens or underscores, starting and ending with a letter or digit.'

export function isUsername(value: string): boolean {
  return USERNAME_PATTERN.test(value)
}

/** Usernames are stored lowercase, so "Ada" and "ada" are one Account. */
export function normalizeUsername(value: string): string {
  return value.toLowerCase()
}

/** A username as its holder types it. Better Auth stores it normalized and keeps this form for showing. */
export const usernameSchema = z.string().trim().regex(USERNAME_PATTERN, USERNAME_HELP)

/** The one sign-in field: a username, or an email address verified on that Account. */
export const loginSchema = z.string().trim().toLowerCase().min(1, 'Enter your username or email').max(254)

export const accountEmailSchema = z.string().trim().toLowerCase().email('Enter a valid email').max(254)

/** An optional email field in a form: blank means none. */
export const optionalEmailSchema = z.union([accountEmailSchema, z.literal('')]).optional()
  .transform(value => value || undefined)

/** Turns a name, an email's local part or a provider profile into something usable as a username. */
export function usernameFrom(seed: string | null | undefined): string {
  const slug = (seed ?? '').trim().toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, '-')
    .replace(/^[._-]+|[._-]+$/gu, '')
    .slice(0, 24)
    .replace(/[._-]+$/gu, '')
  return slug.length >= 3 ? slug : `member-${slug}`.replace(/-$/u, '')
}
