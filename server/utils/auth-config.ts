import { eq } from 'drizzle-orm'
import { authProviderCredentials, authSettings } from '../../drizzle/schema'
import type { AuthCredentialProvider, AuthLoginMethod, AuthMode, AuthSettingsAdminDTO, PublicAuthConfig, RegistrationMode } from '../../shared/types'
import { nowIso } from '../../shared/ids'
import type { L4Env } from '../../workers/env'
import { authEmailAvailable } from '../../workers/mail-transport'
import { decryptAuthSecret } from './auth-secrets'
import { getDb } from './db'
import { authMode } from './cloudflare-access'

export const AUTH_PROVIDERS = ['github', 'google', 'twitter', 'telegram', 'linkedin', 'turnstile'] as const satisfies readonly AuthCredentialProvider[]
export const LOGIN_METHODS = ['email', 'github', 'google', 'twitter', 'telegram', 'linkedin'] as const satisfies readonly AuthLoginMethod[]
export const DEV_AUTH_SECRET = 'llll-dev-secret-do-not-use-in-prod!!'

type Credential = {
  publicKey: string
  secret: string
  source: 'deployment' | 'database'
  secretReadable: boolean
}

export type AuthRuntimeConfig = {
  mode: AuthMode
  registrationMode: RegistrationMode
  enabled: Record<AuthLoginMethod | 'turnstile', boolean>
  credentials: Partial<Record<AuthCredentialProvider, Credential>>
  email: {
    binding: boolean
    from: string | null
    fromName: string | null
    senderManagedByDeployment: boolean
    verificationReady: boolean
  }
}

export function authSecret(env: L4Env, baseURL?: string): string {
  const local = baseURL ? ['localhost', '127.0.0.1', '::1'].includes(new URL(baseURL).hostname) : false
  const secret = (env.AUTH_SECRET || (local ? DEV_AUTH_SECRET : '')).trim()
  if (!secret) throw new Error('AUTH_SECRET is required')
  if (secret.length < 32) throw new Error('AUTH_SECRET must be at least 32 characters')
  return secret
}

export function installedMailboxSender(env: L4Env): string | null {
  const localPart = env.MAIL_DEFAULT_LOCAL_PART?.trim().toLowerCase()
  let domain = ''
  try { domain = JSON.parse(env.LLLL_EMAIL_DOMAINS || '[]')[0]?.domain?.trim().toLowerCase() || '' } catch { /* No configured domain. */ }
  return localPart && domain ? `${localPart}@${domain}` : null
}

function envCredential(env: L4Env, provider: AuthCredentialProvider): Credential | null {
  const pairs: Record<AuthCredentialProvider, [string | undefined, string | undefined]> = {
    github: [env.GITHUB_CLIENT_ID, env.GITHUB_CLIENT_SECRET],
    google: [env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET],
    twitter: [env.TWITTER_CLIENT_ID, env.TWITTER_CLIENT_SECRET],
    telegram: [env.TELEGRAM_CLIENT_ID, env.TELEGRAM_CLIENT_SECRET],
    linkedin: [env.LINKEDIN_CLIENT_ID, env.LINKEDIN_CLIENT_SECRET],
    turnstile: [env.TURNSTILE_SITE_KEY, env.TURNSTILE_SECRET_KEY],
  }
  const pair = pairs[provider]
  const publicKey = pair[0]?.trim()
  const secret = pair[1]?.trim()
  return publicKey && secret ? { publicKey, secret, source: 'deployment', secretReadable: true } : null
}

function registrationDefault(env: L4Env): RegistrationMode {
  return env.AUTH_REGISTRATION_MODE?.trim() === 'open' ? 'open' : 'invite_only'
}

async function ensureSettings(env: L4Env) {
  const db = getDb(env.DB)
  const existing = (await db.select().from(authSettings).where(eq(authSettings.id, 1)).limit(1))[0]
  if (existing) return existing
  const created = nowIso()
  await db.insert(authSettings).values({
    id: 1,
    registrationMode: registrationDefault(env),
    emailEnabled: true,
    githubEnabled: Boolean(envCredential(env, 'github')),
    linkedinEnabled: Boolean(envCredential(env, 'linkedin')),
    googleEnabled: Boolean(envCredential(env, 'google')),
    twitterEnabled: Boolean(envCredential(env, 'twitter')),
    telegramEnabled: Boolean(envCredential(env, 'telegram')),
    turnstileEnabled: Boolean(envCredential(env, 'turnstile')),
    emailFrom: null,
    emailFromName: null,
    createdAt: created,
    updatedAt: created,
  }).onConflictDoNothing()
  return (await db.select().from(authSettings).where(eq(authSettings.id, 1)).limit(1))[0]!
}

// Session checks run on every API request. Reading two settings rows from a
// distant D1 primary each time dominated request latency, so session-only
// callers reuse the resolved config briefly within an isolate. Sign-in, signup
// and settings flows still read the rows fresh.
const SESSION_CONFIG_TTL_MS = 30_000
let sessionConfigCache: { key: string, expiresAt: number, value: Promise<AuthRuntimeConfig> } | null = null

export function loadSessionAuthConfig(env: L4Env, baseURL?: string): Promise<AuthRuntimeConfig> {
  const key = baseURL ?? ''
  const now = Date.now()
  if (sessionConfigCache && sessionConfigCache.key === key && sessionConfigCache.expiresAt > now) {
    return sessionConfigCache.value
  }
  const value = loadAuthRuntimeConfig(env, baseURL)
  sessionConfigCache = { key, expiresAt: now + SESSION_CONFIG_TTL_MS, value }
  value.catch(() => {
    if (sessionConfigCache?.value === value) sessionConfigCache = null
  })
  return value
}

export function forgetSessionAuthConfig() {
  sessionConfigCache = null
}

export async function loadAuthRuntimeConfig(env: L4Env, baseURL?: string): Promise<AuthRuntimeConfig> {
  const db = getDb(env.DB)
  const [settings, stored] = await Promise.all([
    ensureSettings(env),
    db.select().from(authProviderCredentials),
  ])
  const credentials: Partial<Record<AuthCredentialProvider, Credential>> = {}
  const secret = authSecret(env, baseURL)

  await Promise.all(AUTH_PROVIDERS.map(async (provider) => {
    const deployment = envCredential(env, provider)
    if (deployment) {
      credentials[provider] = deployment
      return
    }
    const row = stored.find(item => item.provider === provider)
    if (!row) return
    try {
      credentials[provider] = {
        publicKey: row.publicKey,
        secret: await decryptAuthSecret(secret, provider, {
          ciphertext: row.secretCiphertext,
          iv: row.secretIv,
          version: row.secretVersion,
        }),
        source: 'database',
        secretReadable: true,
      }
    }
    catch {
      credentials[provider] = {
        publicKey: row.publicKey,
        secret: '',
        source: 'database',
        secretReadable: false,
      }
    }
  }))

  const deploymentFrom = env.EMAIL_FROM?.trim() || null
  const from = deploymentFrom ?? settings.emailFrom?.trim() ?? installedMailboxSender(env)
  const fromName = env.EMAIL_FROM_NAME?.trim() || settings.emailFromName?.trim() || null
  const enabled = {
    email: settings.emailEnabled,
    github: settings.githubEnabled,
    linkedin: settings.linkedinEnabled,
    google: settings.googleEnabled,
    twitter: settings.twitterEnabled,
    telegram: settings.telegramEnabled,
    turnstile: settings.turnstileEnabled,
  }
  const binding = authEmailAvailable(env)

  return {
    mode: authMode(env),
    registrationMode: settings.registrationMode,
    enabled,
    credentials,
    email: {
      binding,
      from,
      fromName,
      senderManagedByDeployment: Boolean(deploymentFrom),
      verificationReady: binding && Boolean(from),
    },
  }
}

export function publicAuthConfig(config: AuthRuntimeConfig): PublicAuthConfig {
  if (config.mode === 'access') {
    return {
      mode: 'access',
      registrationMode: 'open',
      signupEnabled: false,
      emailSignupEnabled: false,
      passwordResetEnabled: false,
      methods: { email: false, github: false, google: false, twitter: false, telegram: false, linkedin: false },
      turnstile: { enabled: false, siteKey: null },
    }
  }
  const methods = {
    email: config.enabled.email,
    github: config.enabled.github && credentialReady(config, 'github'),
    linkedin: config.enabled.linkedin && credentialReady(config, 'linkedin'),
    google: config.enabled.google && credentialReady(config, 'google'),
    twitter: config.enabled.twitter && credentialReady(config, 'twitter'),
    telegram: config.enabled.telegram && credentialReady(config, 'telegram'),
  }
  const turnstileReady = config.enabled.turnstile && credentialReady(config, 'turnstile')
  // A private invite is already the admission credential in invite-only mode.
  // Email delivery remains optional there and is only needed for verification
  // and password recovery.
  const emailSignupEnabled = methods.email
  return {
    mode: 'builtin',
    registrationMode: config.registrationMode,
    signupEnabled: config.registrationMode === 'open' && (emailSignupEnabled || methods.github || methods.google || methods.twitter || methods.telegram || methods.linkedin),
    emailSignupEnabled,
    passwordResetEnabled: methods.email && config.email.verificationReady,
    methods,
    turnstile: {
      enabled: turnstileReady,
      siteKey: turnstileReady ? config.credentials.turnstile!.publicKey : null,
    },
  }
}

export function emailVerificationRequired(config: AuthRuntimeConfig): boolean {
  return config.registrationMode === 'invite_only' && config.email.verificationReady
}

export function credentialReady(config: AuthRuntimeConfig, provider: AuthCredentialProvider): boolean {
  const credential = config.credentials[provider]
  return Boolean(credential?.publicKey && credential.secret && credential.secretReadable)
}

export function authSettingsAdminDto(config: AuthRuntimeConfig): AuthSettingsAdminDTO {
  const publicConfig = publicAuthConfig(config)
  const providerDto = (provider: AuthCredentialProvider) => {
    const credential = config.credentials[provider]
    return {
      provider,
      enabled: config.enabled[provider],
      configured: Boolean(credential),
      effective: config.enabled[provider] && credentialReady(config, provider),
      source: credential?.source ?? 'missing',
      publicKey: credential?.publicKey ?? null,
      secretReadable: credential?.secretReadable ?? true,
    } as const
  }
  return {
    ...publicConfig,
    email: {
      enabled: config.enabled.email,
      binding: config.email.binding,
      sender: config.email.from,
      senderName: config.email.fromName,
      verificationReady: config.email.verificationReady,
      senderManagedByDeployment: config.email.senderManagedByDeployment,
    },
    providers: {
      github: providerDto('github'),
      linkedin: providerDto('linkedin'),
      google: providerDto('google'),
      twitter: providerDto('twitter'),
      telegram: providerDto('telegram'),
      turnstile: providerDto('turnstile'),
    },
  }
}
