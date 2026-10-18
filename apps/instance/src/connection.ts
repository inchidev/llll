import { z } from 'zod'
import { APIError, createAuthEndpoint, getSessionFromCtx } from 'better-auth/api'
import { setSessionCookie } from 'better-auth/cookies'
import type { InstanceEnv } from './env'

const encoder = new TextEncoder()
async function hash(value: string) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)))].map(b => b.toString(16).padStart(2, '0')).join('') }
async function challenge(value: string) { return btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '') }
const codePattern = /^[a-zA-Z0-9_-]{43,128}$/

/** One-use S256 handoff: browser sessions never appear in a callback URL. */
export function installationConnection(env: InstanceEnv, allowedOrigins: string[]) {
  function redirectUri(value: string) {
    if (value === 'llll://connections' && allowedOrigins.includes('capacitor://localhost')) return value
    const url = new URL(value)
    if (!allowedOrigins.includes(url.origin) || url.pathname !== '/connections' || url.search || url.hash) throw new APIError('BAD_REQUEST', { message: 'Client callback is not allowed' })
    return url.toString()
  }
  return {
    id: 'llll-connection',
    endpoints: {
      connectionAuthorize: createAuthEndpoint('/connection/authorize', { method: 'GET', query: z.object({ redirect_uri: z.string().url(), state: z.string().regex(codePattern), code_challenge: z.string().regex(/^[a-zA-Z0-9_-]{43}$/) }), requireHeaders: true }, async ctx => {
        const redirect = redirectUri(ctx.query.redirect_uri)
        const current = await getSessionFromCtx(ctx)
        if (!current) {
          const back = new URL('/api/auth/connection/authorize', env.PUBLIC_ORIGIN)
          for (const [key, value] of Object.entries(ctx.query)) back.searchParams.set(key, value)
          throw ctx.redirect(`${env.PUBLIC_ORIGIN}/connections?return_to=${encodeURIComponent(back.toString())}`)
        }
        const code = [...crypto.getRandomValues(new Uint8Array(32))].map(b => b.toString(16).padStart(2, '0')).join('')
        await env.INSTALLATION_DB.prepare('DELETE FROM connection_grants WHERE expires_at < ?').bind(Date.now()).run()
        await env.INSTALLATION_DB.prepare('INSERT INTO connection_grants (code_hash,user_id,session_id,challenge,redirect_uri,expires_at) VALUES (?,?,?,?,?,?)').bind(await hash(code), current.user.id, current.session.id, ctx.query.code_challenge, redirect, Date.now() + 90000).run()
        const target = new URL(redirect)
        target.hash = new URLSearchParams({ llll_connection: code, state: ctx.query.state, installation: env.PUBLIC_ORIGIN }).toString()
        throw ctx.redirect(target.toString())
      }),
      connectionExchange: createAuthEndpoint('/connection/exchange', { method: 'POST', body: z.object({ code: z.string().regex(/^[a-f0-9]{64}$/), code_verifier: z.string().regex(codePattern), redirect_uri: z.string().url() }), requireHeaders: true }, async ctx => {
        const redirect = redirectUri(ctx.body.redirect_uri)
        const grant = await env.INSTALLATION_DB.prepare('DELETE FROM connection_grants WHERE code_hash = ? AND challenge = ? AND redirect_uri = ? AND expires_at > ? RETURNING user_id,session_id').bind(await hash(ctx.body.code), await challenge(ctx.body.code_verifier), redirect, Date.now()).first<{ user_id: string; session_id: string }>()
        if (!grant) throw new APIError('UNAUTHORIZED', { message: 'Connection expired or was already used' })
        const valid = await env.INSTALLATION_DB.prepare('SELECT id FROM auth_sessions WHERE id = ? AND expires_at > ?').bind(grant.session_id, Date.now()).first()
        const user = await ctx.context.internalAdapter.findUserById(grant.user_id)
        if (!valid || !user) throw new APIError('UNAUTHORIZED', { message: 'Sign in again to connect this client' })
        const session = await ctx.context.internalAdapter.createSession(user.id)
        await setSessionCookie(ctx, { user, session })
        return ctx.json({ user: { id: user.id, name: user.name }, ok: true })
      }),
    },
  }
}
