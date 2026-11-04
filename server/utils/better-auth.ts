import { getServerId } from '../../shared/server-id'
import { serverConnection } from './connection-auth'
import { generatedUsername, placeholderId, verifiedEmail } from './account-identity'
import { USERNAME_MAX_LENGTH, USERNAME_MIN_LENGTH, isUsername, normalizeUsername } from '../../shared/account'
import { writeAudit } from './messages'
import { betterAuth } from 'better-auth'
import { bearer, username } from 'better-auth/plugins'
import { drizzleAdapter } from '@better-auth/drizzle-adapter'
import type { H3Event } from 'h3'
import { authAccounts, authSessions, authUsers, authVerifications, oauthTables } from '../../drizzle/schema'
import { mcpOAuthProvider } from './mcp-oauth-provider'
import type { L4Env } from '../../workers/env'
import { readAppBranding } from '../../shared/app-branding'
import { sendAuthEmail as deliverAuthEmail } from '../../workers/mail-transport'
import { authSecret, loadAuthRuntimeConfig, loadSessionAuthConfig, publicAuthConfig, type AuthRuntimeConfig } from './auth-config'
import { allowedServerOrigins, primaryServerOrigin } from './server-origins'
import { cf } from './cf'
import { getDb } from './db'
import { hashPassword, verifyPassword } from './password'

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[char]!)
}

export async function sendAuthEmail(
  env: L4Env,
  from: string,
  fromName: string | null,
  to: string,
  subject: string,
  introduction: string,
  action: string,
  url: string,
) {
  const safeUrl = escapeHtml(url)
  await deliverAuthEmail(env, {
    to,
    from: fromName ? { email: from, name: fromName } : from,
    subject,
    text: `${introduction}\n\n${action}: ${url}\n\nThis link expires in one hour.`,
    html: `<p>${escapeHtml(introduction)}</p><p><a href="${safeUrl}">${escapeHtml(action)}</a></p><p>This link expires in one hour.</p>`,
  })
}

export async function createAuth(
  env: L4Env,
  baseURL: string,
  waitUntil: (promise: Promise<unknown>) => void = promise => void promise,
  runtimeConfig?: AuthRuntimeConfig,
  mcpConnectionId?: string,
  enableMcpOAuth = false,
  allowedOrigins: string[] = [baseURL],
) {
  const config = runtimeConfig ?? await loadAuthRuntimeConfig(env, baseURL)
  const origins = [...new Set(allowedOrigins.length ? allowedOrigins : [baseURL])]
  const publicConfig = publicAuthConfig(config)
  const google = config.credentials.google
  const linkedin = config.credentials.linkedin
  const github = config.credentials.github
  const twitter = config.credentials.twitter
  const appName = readAppBranding().appName

  return betterAuth({
    secret: authSecret(env, baseURL),
    baseURL,
    database: drizzleAdapter(getDb(env.DB), {
      provider: 'sqlite',
      schema: {
        user: authUsers,
        session: authSessions,
        account: authAccounts,
        verification: authVerifications,
        ...oauthTables,
      },
    }),
    databaseHooks: {
      user: {
        create: {
          before: async (user, context) => {
            // Sign-up chose this Account's id and put it in the placeholder, `<id>@no-email.invalid`.
            const id = context?.path === '/sign-up/email' ? placeholderId(user.email) : null
            // Only an Account made by a provider arrives without a username: it gets one it can change.
            const typed = (user as { username?: string | null }).username
            const generated = typed ? null : await generatedUsername(getDb(env.DB), user.name || user.email.split('@')[0])
            return { data: { ...user, ...(id ? { id } : {}), ...(generated ? { username: generated, displayUsername: generated } : {}) } }
          },
        },
      },
    },
    account: { accountLinking: { disableImplicitLinking: true, allowDifferentEmails: true } },
    emailAndPassword: {
      enabled: config.enabled.password,
      // Sign-up stays on for auth.api.signUpEmail, called by /api/auth/signup. Its HTTP path is
      // closed in server/api/auth/[...all].ts, because the invite rules live in that route.
      // Must stay false: an Account with no email is never verified, and the username plugin
      // would refuse it. /api/auth/login only lets a verified address name an Account.
      requireEmailVerification: false,
      minPasswordLength: 8,
      // Above Better Auth's 128: our routes take up to 200, and its plugin enforces this on sign-in.
      maxPasswordLength: 200,
      resetPasswordTokenExpiresIn: 60 * 60,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: config.email.verificationReady
        ? async ({ user, url }) => {
            const to = verifiedEmail(user)
            if (!to) return
            waitUntil(sendAuthEmail(
              env,
              config.email.from!,
              config.email.fromName,
              to,
              `Reset your ${appName} password`,
              `A password reset was requested for your ${appName} account.`,
              'Reset password',
              url,
            ))
          }
        : undefined,
      onPasswordReset: async ({ user }) => {
        await writeAudit(env, { serverId: await getServerId(env.DB), actorId: user.id, action: 'account.password.reset', targetType: 'user', targetId: user.id })
      },
      password: {
        hash: async password => hashPassword(password),
        verify: async ({ password, hash }) => verifyPassword(password, hash),
      },
    },
    socialProviders: {
      ...(publicConfig.methods.linkedin && linkedin
        ? { linkedin: { clientId: linkedin.publicKey, clientSecret: linkedin.secret, disableImplicitSignUp: true } }
        : {}),
      ...(publicConfig.methods.google && google
        ? { google: { clientId: google.publicKey, clientSecret: google.secret, disableImplicitSignUp: true } }
        : {}),
      ...(publicConfig.methods.github && github
        ? { github: { clientId: github.publicKey, clientSecret: github.secret, disableImplicitSignUp: true } }
        : {}),
      ...(publicConfig.methods.twitter && twitter
        ? { twitter: { clientId: twitter.publicKey, clientSecret: twitter.secret, disableImplicitSignUp: true } }
        : {}),
    },
    plugins: [
      ...(enableMcpOAuth ? [mcpOAuthProvider(env, baseURL, mcpConnectionId)] : []),
      bearer({ requireSignature: true }),
      username({
        minUsernameLength: USERNAME_MIN_LENGTH,
        maxUsernameLength: USERNAME_MAX_LENGTH,
        usernameValidator: isUsername,
        usernameNormalization: normalizeUsername,
      }),
      serverConnection({ ...env, PUBLIC_ORIGIN: baseURL }, origins),
    ],
    trustedOrigins: origins,
    advanced: {
      cookiePrefix: `llll-server${new URL(baseURL).port ? '-' + new URL(baseURL).port : ''}`,
      useSecureCookies: baseURL.startsWith('https://'),
    },
  })
}

export function resolveAuthBaseURL(configuredOrigin: string | undefined, requestOrigin: string) {
  const value = configuredOrigin?.trim()
  if (!value) return new URL(requestOrigin).origin

  let url: URL
  try {
    url = new URL(value)
  }
  catch {
    throw new Error('PUBLIC_ORIGIN must be an absolute HTTP or HTTPS origin')
  }

  if (
    !['http:', 'https:'].includes(url.protocol)
    || url.username
    || url.password
    || url.pathname !== '/'
    || url.search
    || url.hash
  ) {
    throw new Error('PUBLIC_ORIGIN must contain only an HTTP or HTTPS origin')
  }

  return url.origin
}

export async function authRequestContext(event: H3Event): Promise<{ baseURL: string, origins: string[] }> {
  const { env } = cf(event)
  const requestOrigin = getRequestURL(event).origin
  const origins = await allowedServerOrigins(env, requestOrigin)
  const primary = await primaryServerOrigin(env, requestOrigin)
  const baseURL = origins.includes(requestOrigin) ? requestOrigin : primary || requestOrigin
  return { baseURL, origins: origins.length ? origins : [baseURL] }
}

export async function authFromEvent(event: H3Event) {
  const { env, waitUntil } = cf(event)
  const { baseURL, origins } = await authRequestContext(event)
  return createAuth(env, baseURL, waitUntil,
    undefined, undefined, event.path.split('?')[0]!.startsWith('/api/auth/oauth2/'), origins)
}

export async function mcpAuthFromEvent(event: H3Event, connectionId?: string) {
  const { env, waitUntil } = cf(event)
  const { baseURL, origins } = await authRequestContext(event)
  return createAuth(env, baseURL, waitUntil, undefined, connectionId, true, origins)
}

/** Auth engine for reading the current session; uses the briefly cached runtime config. */
export async function sessionAuthFromEvent(event: H3Event) {
  const { env, waitUntil } = cf(event)
  const { baseURL, origins } = await authRequestContext(event)
  return createAuth(env, baseURL, waitUntil, await loadSessionAuthConfig(env, baseURL), undefined, false, origins)
}
