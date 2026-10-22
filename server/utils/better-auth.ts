import { serverConnection } from './connection-auth'
import { serverTelegram } from './telegram-auth'
import { betterAuth } from 'better-auth'
import { bearer, captcha, genericOAuth } from 'better-auth/plugins'
import { drizzleAdapter } from '@better-auth/drizzle-adapter'
import type { H3Event } from 'h3'
import { authAccounts, authSessions, authUsers, authVerifications, oauthTables } from '../../drizzle/schema'
import { mcpOAuthProvider } from './mcp-oauth-provider'
import type { L4Env } from '../../workers/env'
import { readAppBranding } from '../../shared/app-branding'
import { sendAuthEmail as deliverAuthEmail } from '../../workers/mail-transport'
import { authSecret, credentialReady, emailVerificationRequired, loadAuthRuntimeConfig, loadSessionAuthConfig, publicAuthConfig, type AuthRuntimeConfig } from './auth-config'
import { allowedServerOrigins, primaryServerOrigin } from './server-origins'
import { cf } from './cf'
import { getDb } from './db'
import { hashPassword, verifyPassword } from './password'

type TelegramClaims = {
  sub?: unknown
  name?: unknown
  preferred_username?: unknown
  picture?: unknown
}

function telegramClaims(idToken: string | undefined): TelegramClaims | null {
  if (!idToken) return null
  try {
    const encoded = idToken.split('.')[1]
    if (!encoded) return null
    const base64 = encoded.replaceAll('-', '+').replaceAll('_', '/').padEnd(Math.ceil(encoded.length / 4) * 4, '=')
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(base64), char => char.charCodeAt(0)))) as TelegramClaims
  }
  catch {
    return null
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[char]!)
}

async function sendAuthEmail(
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
  const telegram = config.credentials.telegram
  const turnstile = config.credentials.turnstile
  const requireEmailVerification = emailVerificationRequired(config)
  const appName = readAppBranding(env).appName

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
    account: { accountLinking: { disableImplicitLinking: true, allowDifferentEmails: true } },
    emailAndPassword: {
      enabled: config.enabled.email,
      disableSignUp: !publicConfig.emailSignupEnabled,
      requireEmailVerification,
      minPasswordLength: 8,
      resetPasswordTokenExpiresIn: 60 * 60,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: config.email.verificationReady
        ? async ({ user, url }) => {
            waitUntil(sendAuthEmail(
              env,
              config.email.from!,
              config.email.fromName,
              user.email,
              `Reset your ${appName} password`,
              `A password reset was requested for your ${appName} account.`,
              'Reset password',
              url,
            ))
          }
        : undefined,
      password: {
        hash: async password => hashPassword(password),
        verify: async ({ password, hash }) => verifyPassword(password, hash),
      },
    },
    emailVerification: config.email.verificationReady
      ? {
          sendOnSignUp: requireEmailVerification,
          sendOnSignIn: requireEmailVerification,
          autoSignInAfterVerification: false,
          expiresIn: 60 * 60,
          sendVerificationEmail: async ({ user, url }) => {
            waitUntil(sendAuthEmail(
              env,
              config.email.from!,
              config.email.fromName,
              user.email,
              `Verify your ${appName} email`,
              `Verify your email address to join ${appName}.`,
              'Verify email',
              url,
            ))
          },
        }
      : undefined,
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
      serverConnection({ ...env, PUBLIC_ORIGIN: baseURL }, origins),
      serverTelegram(env, config.registrationMode),
      ...(publicConfig.methods.telegram && telegram
        ? [genericOAuth({
            config: [{
              providerId: 'telegram',
              name: 'Telegram',
              clientId: telegram.publicKey,
              clientSecret: telegram.secret,
              discoveryUrl: 'https://oauth.telegram.org/.well-known/openid-configuration',
              requireIdTokenVerification: true,
              scopes: ['openid', 'profile'],
              authentication: 'basic',
              disableImplicitSignUp: true,
              getUserInfo: async (tokens) => {
                const claims = telegramClaims(tokens.idToken)
                const sub = typeof claims?.sub === 'string' || typeof claims?.sub === 'number' ? String(claims.sub) : ''
                if (!sub) return null
                const username = typeof claims?.preferred_username === 'string' ? claims.preferred_username : ''
                return {
                  ...claims,
                  id: sub,
                  sub,
                  email: `telegram-${sub}@identity.llll.invalid`,
                  emailVerified: true,
                  name: typeof claims?.name === 'string' ? claims.name : username || 'Telegram member',
                  image: typeof claims?.picture === 'string' ? claims.picture : undefined,
                }
              },
            }],
          })]
        : []),
      ...(config.enabled.turnstile && credentialReady(config, 'turnstile') && turnstile
        ? [captcha({
            provider: 'cloudflare-turnstile',
            secretKey: turnstile.secret,
            endpoints: ['/sign-up/email'],
            expectedAction: 'signup',
            allowedHostnames: [...new Set(origins.map(origin => new URL(origin).hostname))],
          })]
        : []),
    ],
    trustedOrigins: origins,
    advanced: {
      cookiePrefix: `llll-server${new URL(baseURL).port ? '-' + new URL(baseURL).port : ''}`,
      cookies: baseURL.startsWith('https:') ? { session_token: { attributes: { sameSite: 'none', secure: true, partitioned: true } } } : undefined,
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
