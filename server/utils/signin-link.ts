import { z } from 'zod'
import { APIError, createAuthEndpoint } from 'better-auth/api'
import { setSessionCookie } from 'better-auth/cookies'
import { sha256Hex } from '../../shared/server-settings'
import type { L4Env } from '../../workers/env'

/**
 * A one-time sign-in link (ADR 0012): the control plane asks the Server for one on a partner's behalf, the
 * partner's app opens it, and the Member gets an ordinary session. The Server keeps only the token's digest,
 * for ten minutes, in Better Auth's verification table; the exchange deletes it, so a link works once.
 */
export const SIGNIN_LINK_MS = 10 * 60 * 1000
export const SIGNIN_LINK_PATH = '/signin/link'
const IDENTIFIER = 'signin-link:'
const TOKEN = /^[0-9a-f]{64}$/u

export async function mintSignInLink(env: L4Env, userId: string, origin: string) {
  const token = [...crypto.getRandomValues(new Uint8Array(32))].map(byte => byte.toString(16).padStart(2, '0')).join('')
  const now = Date.now()
  const expiresAt = now + SIGNIN_LINK_MS
  await env.DB.prepare('INSERT INTO auth_verifications (id, identifier, value, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(crypto.randomUUID(), IDENTIFIER + await sha256Hex(token), userId, expiresAt, now, now).run()
  return { url: `${origin}${SIGNIN_LINK_PATH}#${token}`, expiresAt: new Date(expiresAt).toISOString() }
}

/** The Member a link names, once: a second call with the same token finds nothing. */
export async function consumeSignInLink(env: L4Env, token: string): Promise<string | null> {
  if (!TOKEN.test(token)) return null
  const row = await env.DB.prepare('DELETE FROM auth_verifications WHERE identifier = ? AND expires_at > ? RETURNING value')
    .bind(IDENTIFIER + await sha256Hex(token), Date.now()).first<{ value: string }>()
  return row?.value ?? null
}

/** Exchanges a link for a session, inside Better Auth so that the cookie is the one every sign-in sets. */
export function signInLink(env: L4Env) {
  return {
    id: 'llll-signin-link',
    endpoints: {
      linkExchange: createAuthEndpoint('/link/exchange', { method: 'POST', body: z.object({ token: z.string().regex(TOKEN) }), requireHeaders: true }, async (ctx) => {
        const userId = await consumeSignInLink(env, ctx.body.token)
        const member = userId ? await env.DB.prepare("SELECT id FROM users WHERE id = ? AND status = 'active' AND kind = 'human'").bind(userId).first() : null
        const user = member ? await ctx.context.internalAdapter.findUserById(userId!) : null
        if (!user) throw new APIError('UNAUTHORIZED', { message: 'This sign-in link is invalid, expired or already used' })
        const session = await ctx.context.internalAdapter.createSession(user.id)
        await setSessionCookie(ctx, { user, session })
        return ctx.json({ user: { id: user.id, email: user.email, name: user.name, username: (user as { username?: string | null }).username ?? null, displayUsername: (user as { displayUsername?: string | null }).displayUsername ?? null, image: user.image ?? null } })
      }),
    },
  }
}
