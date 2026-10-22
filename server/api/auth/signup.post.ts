import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { authUsers, invites } from '../../../drizzle/schema'
import { ensureDomainUser, sessionUser, visibleAuthEmail } from '../../utils/auth'
import { emailVerificationRequired, loadAuthRuntimeConfig, publicAuthConfig } from '../../utils/auth-config'
import { authFromEvent, authRequestContext } from '../../utils/better-auth'
import { cf, fail } from '../../utils/cf'
import { ensureMigrated, getDb, serverReady } from '../../utils/db'
import { parseBody } from '../../utils/validate'
import { recordOnboardingAcceptance, requireCurrentOnboardingAcceptance } from '../../utils/onboarding'

const bodySchema = z.object({
  name: z.string().trim().min(1).max(80),
  email: z.string().email().max(200),
  password: z.string().min(8).max(200),
  inviteCode: z.string().trim().max(100).optional(),
  accepted: z.boolean().default(false),
  onboardingRevisionId: z.string().max(100).nullable().optional(),
})

export default defineEventHandler(async (event) => {
  const body = parseBody(bodySchema, await readBody(event))
  const { env } = cf(event)
  await ensureMigrated(env.DB, env)
  if (!(await serverReady(env.DB))) fail(409, 'server_not_ready', 'The server owner must complete setup first')
  const runtime = await loadAuthRuntimeConfig(env, (await authRequestContext(event)).baseURL)
  const publicConfig = publicAuthConfig(runtime)

  if (!publicConfig.emailSignupEnabled) {
    fail(403, 'signup_disabled', 'Email signup is not available')
  }

  let validInvite = false
  if (body.inviteCode) {
    const invite = (await getDb(env.DB).select().from(invites).where(eq(invites.code, body.inviteCode)).limit(1))[0]
    validInvite = Boolean(invite
      && (!invite.expiresAt || new Date(invite.expiresAt).getTime() >= Date.now())
      && (invite.maxUses === 0 || invite.uses < invite.maxUses))
  }
  if (runtime.registrationMode === 'invite_only' && !validInvite) {
    fail(403, 'invite_required', 'A valid invite is required')
  }
  const onboarding = await requireCurrentOnboardingAcceptance(env, body.onboardingRevisionId, body.accepted)
  const ip = getHeader(event, 'cf-connecting-ip') || getHeader(event, 'x-forwarded-for') || 'local'
  let allowed = true
  try {
    const limiter = asRpc<{ take: (limit: number, windowMs: number) => Promise<boolean> }>(env.RATE_LIMIT_DO.getByName(`ip:${ip}:signup`))
    allowed = await limiter.take(5, 60 * 60 * 1000)
  }
  catch {
    // nuxt cloudflare-dev does not export DOs
  }
  if (!allowed) fail(429, 'rate_limited', 'Too many signup attempts')

  const callback = new URL('/login', (await authRequestContext(event)).baseURL)
  callback.searchParams.set('verified', '1')
  if (body.inviteCode) callback.searchParams.set('next', `/invite/${encodeURIComponent(body.inviteCode)}`)

  const auth = await authFromEvent(event)
  const response = await auth.api.signUpEmail({
    headers: event.headers,
    body: {
      name: body.name,
      email: body.email.trim().toLowerCase(),
      password: body.password,
      callbackURL: callback.toString(),
    },
    asResponse: true,
  })
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { message?: string } | null
    fail(response.status, 'signup_failed', payload?.message || 'Could not create account')
  }
  for (const cookie of response.headers.getSetCookie?.() ?? []) appendResponseHeader(event, 'set-cookie', cookie)

  const signedUp = await response.json() as { user: { id: string; email: string; name: string; image?: string | null } }
  const persistedIdentity = (await getDb(env.DB).select({ id: authUsers.id }).from(authUsers).where(eq(authUsers.id, signedUp.user.id)).limit(1))[0]
  if (persistedIdentity) await recordOnboardingAcceptance(env, signedUp.user.id, onboarding.revisionId)
  const verificationRequired = emailVerificationRequired(runtime)
  if (verificationRequired) return { ok: true, verificationRequired }

  await getDb(env.DB)
    .update(authUsers)
    .set({ emailVerified: true, updatedAt: new Date() })
    .where(eq(authUsers.id, signedUp.user.id))
  const row = await ensureDomainUser(event, signedUp.user)
  return {
    ok: true,
    verificationRequired,
    user: await sessionUser(event, row, visibleAuthEmail(signedUp.user.email)),
  }
})
