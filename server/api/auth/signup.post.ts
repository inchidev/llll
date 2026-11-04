import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { invites } from '../../../drizzle/schema'
import { normalizeUsername, optionalEmailSchema, usernameSchema } from '../../../shared/account'
import { newId } from '../../../shared/ids'
import { addPendingEmail } from '../../utils/account-email'
import { isUsernameConflict, placeholderEmail } from '../../utils/account-identity'
import { ensureDomainUser, sessionUser } from '../../utils/auth'
import { loadAuthRuntimeConfig, publicAuthConfig } from '../../utils/auth-config'
import { authFromEvent, authRequestContext } from '../../utils/better-auth'
import { cf, fail } from '../../utils/cf'
import { ensureMigrated, getDb, serverReady } from '../../utils/db'
import { verifyTurnstile } from '../../utils/turnstile'
import { parseBody } from '../../utils/validate'
import { recordOnboardingAcceptance, requireCurrentOnboardingAcceptance } from '../../utils/onboarding'
import { clientIp, requireRateLimit } from '../../utils/rate-limit'

const bodySchema = z.object({
  username: usernameSchema,
  name: z.string().trim().max(80).optional(),
  email: optionalEmailSchema,
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
  const db = getDb(env.DB)

  let validInvite = false
  if (body.inviteCode) {
    const invite = (await db.select().from(invites).where(eq(invites.code, body.inviteCode)).limit(1))[0]
    validInvite = Boolean(invite
      && (!invite.expiresAt || new Date(invite.expiresAt).getTime() >= Date.now())
      && (invite.maxUses === 0 || invite.uses < invite.maxUses))
  }
  if (runtime.registrationMode === 'invite_only' && !validInvite) {
    fail(403, 'invite_required', 'A valid invite is required')
  }
  // An invite is the admission credential and never needs mail. Without one, a stranger
  // needs the open-registration rule met, and an address the Server can write to.
  if (!(validInvite ? publicConfig.inviteSignupEnabled : publicConfig.emailSignupEnabled)) {
    fail(403, 'signup_disabled', 'Signup is not available')
  }
  if (!validInvite && !body.email) fail(400, 'email_required', 'Enter your email')
  const onboarding = await requireCurrentOnboardingAcceptance(env, body.onboardingRevisionId, body.accepted)
  await requireRateLimit(event, [{ key: `ip:${clientIp(event)}:signup`, limit: 5, windowMs: 60 * 60 * 1000 }], 'Too many signup attempts')
  // `auth.api` skips Better Auth's request hooks, so its captcha plugin never sees this call: the check is here.
  if (publicConfig.turnstile.enabled) {
    const token = getHeader(event, 'x-captcha-response')?.trim()
    const hostnames = (await authRequestContext(event)).origins.map(origin => new URL(origin).hostname)
    if (!token || !await verifyTurnstile(runtime.credentials.turnstile!.secret, token, clientIp(event), hostnames)) fail(403, 'captcha_failed', 'Complete the security check and try again')
  }

  const userId = newId()
  const email = placeholderEmail(userId)
  const auth = await authFromEvent(event)
  // The username plugin validates, normalizes and checks it is free; the typed form becomes displayUsername.
  const account = { name: body.name || body.username, email, password: body.password, username: body.username }
  // The plugin refuses in a before-hook, and those throw even with asResponse.
  const response = await auth.api.signUpEmail({ headers: event.headers, body: account, asResponse: true }).catch((error: unknown) => {
    if (isUsernameConflict(error)) fail(409, 'username_taken', 'That username is taken')
    throw error
  })
  if (!response.ok) fail(response.status, 'signup_failed', 'The Account could not be created. Try again in a moment.')
  await recordOnboardingAcceptance(env, userId, onboarding.revisionId)
  for (const cookie of response.headers.getSetCookie?.() ?? []) appendResponseHeader(event, 'set-cookie', cookie)

  const emailConfirmationSent = body.email ? await addPendingEmail(event, userId, body.email) : false
  const username = normalizeUsername(body.username)
  const row = await ensureDomainUser(event, { id: userId, email, username, name: body.name || body.username })
  return {
    ok: true,
    emailConfirmationSent,
    user: await sessionUser(event, row, { username, displayUsername: body.username, email: null }),
  }
})
