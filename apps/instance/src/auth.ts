import { betterAuth } from 'better-auth'
import { drizzleAdapter } from '@better-auth/drizzle-adapter'
import { bearer, genericOAuth, jwt } from 'better-auth/plugins'
import { drizzle } from 'drizzle-orm/d1'
import { hashPassword, verifyPassword } from '../../../server/utils/password'
import * as schema from './schema'
import * as identitySchema from './identity-schema'
import { oauthProvider } from '@better-auth/oauth-provider'
import { installationConnection } from './connection'
import type { InstanceEnv } from './env'
import { installationTelegram } from './telegram'
import { embedOrigins } from '../../../shared/embed'
import { decodeJwt } from 'jose'

export function clientOrigins(env: InstanceEnv) {
  return [new URL(env.PUBLIC_ORIGIN).origin, 'capacitor://localhost', 'tauri://localhost', 'http://tauri.localhost', 'https://tauri.localhost', ...embedOrigins(env.EMBED_ORIGINS), ...(env.CLIENT_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean)]
}

export function installationAuth(env: InstanceEnv, setup = false) {
  return betterAuth({
    appName: 'L4', baseURL: env.PUBLIC_ORIGIN, secret: env.AUTH_SECRET,
    database: drizzleAdapter(drizzle(env.INSTALLATION_DB), { provider: 'sqlite', schema: { ...schema, ...identitySchema } }),
    trustedOrigins: clientOrigins(env),
    disabledPaths: ['/token'],
    emailAndPassword: {
      enabled: true, disableSignUp: !setup && env.REGISTRATION_MODE !== 'open', minPasswordLength: 10,
      password: { hash: hashPassword, verify: ({ password, hash }) => verifyPassword(password, hash) },
    },
    session: { expiresIn: 7 * 86400, freshAge: 600, cookieCache: { enabled: false } },
    account: { encryptOAuthTokens: true, accountLinking: { enabled: true, disableImplicitLinking: true, allowDifferentEmails: true, trustedProviders: ['telegram', 'llll'] } },
    advanced: {
      cookiePrefix: 'llll-installation', useSecureCookies: env.PUBLIC_ORIGIN.startsWith('https:'),
      cookies: env.PUBLIC_ORIGIN.startsWith('https:') ? { session_token: { attributes: { sameSite: 'none', secure: true, partitioned: true } } } : undefined,
    },
    plugins: [
      bearer({ requireSignature: true }), installationTelegram(env), installationConnection(env, clientOrigins(env)),
      ...(env.IDENTITY_PROVIDER === 'true' ? [jwt(), oauthProvider({ loginPage: '/connections', consentPage: '/consent', grantTypes: ['authorization_code', 'refresh_token'], clientPrivileges: async ({ user }) => Boolean(user && user.id === (await env.INSTALLATION_DB.prepare('SELECT owner_id FROM installation_meta WHERE id = 1').first<{ owner_id: string }>())?.owner_id) })] : []),
      ...(env.TELEGRAM_CLIENT_ID && env.TELEGRAM_CLIENT_SECRET ? [genericOAuth({ config: [{
        providerId: 'telegram', clientId: env.TELEGRAM_CLIENT_ID, clientSecret: env.TELEGRAM_CLIENT_SECRET,
        discoveryUrl: 'https://oauth.telegram.org/.well-known/openid-configuration', scopes: ['openid', 'profile'], pkce: true, authentication: 'basic', requireIdTokenVerification: true,
        disableSignUp: env.REGISTRATION_MODE !== 'open',
        accountSubject: ({ profile }) => String(profile.id),
        getUserInfo: async (tokens) => {
          if (!tokens.idToken) return null
          const claims = decodeJwt(tokens.idToken)
          const id = String(claims.id || '')
          if (!/^[1-9]\d{0,15}$/.test(id)) return null
          return { ...claims, id, email: `telegram-${id}@identity.llll.invalid`, emailVerified: false, name: typeof claims.name === 'string' ? claims.name : 'Telegram member', image: typeof claims.picture === 'string' ? claims.picture : undefined }
        },
      }] })] : []),
      ...(env.IDENTITY_ISSUER && env.IDENTITY_CLIENT_ID && env.IDENTITY_CLIENT_SECRET ? [genericOAuth({ config: [{
        providerId: 'llll', clientId: env.IDENTITY_CLIENT_ID, clientSecret: env.IDENTITY_CLIENT_SECRET,
        discoveryUrl: `${env.IDENTITY_ISSUER.replace(/\/$/, '')}/.well-known/openid-configuration`, scopes: ['openid', 'profile', 'email'], pkce: true,
        requireIdTokenVerification: true,
      }] })] : []),
    ],
  })
}
