import { describe, expect, it } from 'vitest'
import { emailVerificationRequired, installedMailboxSender, publicAuthConfig, type AuthRuntimeConfig } from '../../server/utils/auth-config'
import { authEmailAvailable } from '../../workers/mail-transport'

function runtime(overrides: Partial<AuthRuntimeConfig> = {}): AuthRuntimeConfig {
  return {
    mode: 'builtin',
    registrationMode: 'invite_only',
    enabled: { email: true, github: false, google: false, linkedin: false, twitter: false, telegram: false, turnstile: false },
    credentials: {},
    email: { binding: false, from: null, fromName: null, senderManagedByDeployment: false, verificationReady: false },
    ...overrides,
  }
}

describe('public auth config', () => {
  it.each(['google', 'linkedin'] as const)('gates %s on usable credentials and the owner switch', (provider) => {
    const config = runtime({ registrationMode: 'open' })
    config.enabled.email = false
    config.enabled[provider] = true
    expect(publicAuthConfig(config).methods[provider]).toBe(false)
    expect(publicAuthConfig(config).signupEnabled).toBe(false)
    config.credentials[provider] = { publicKey: 'client-id', secret: 'client-secret', source: 'database', secretReadable: true }
    expect(publicAuthConfig(config).methods[provider]).toBe(true)
    expect(publicAuthConfig(config).signupEnabled).toBe(true)
    config.credentials[provider]!.secretReadable = false
    expect(publicAuthConfig(config).methods[provider]).toBe(false)
    config.credentials[provider]!.secretReadable = true
    config.enabled[provider] = false
    expect(publicAuthConfig(config).methods[provider]).toBe(false)
  })

  it('uses an installed server mailbox for auth email delivery', () => {
    const mailEmail = { send: () => Promise.resolve() } as unknown as SendEmail
    const email = { send: () => Promise.resolve() } as unknown as SendEmail

    expect(authEmailAvailable({ MAIL_EMAIL: mailEmail } as never)).toBe(true)
    expect(authEmailAvailable({ EMAIL: email, MAIL_EMAIL: mailEmail } as never)).toBe(true)
    expect(authEmailAvailable({ MAIL_GATEWAY: { fetch: () => Promise.resolve(new Response()) }, MAIL_GATEWAY_TOKEN: 'token' } as never)).toBe(true)
    expect(installedMailboxSender({ MAIL_DEFAULT_LOCAL_PART: 'Inbox', LLLL_EMAIL_DOMAINS: JSON.stringify([{ id: 'mail', zoneId: '', domain: 'Chat.Example.com' }]) } as never)).toBe('inbox@chat.example.com')
  })

  it('requires both credentials and the owner switch for social login', () => {
    const config = runtime({
      enabled: { email: true, github: true, google: false, linkedin: false, twitter: false, telegram: false, turnstile: false },
      credentials: { github: { publicKey: 'id', secret: 'secret', source: 'database', secretReadable: true } },
    })
    expect(publicAuthConfig(config).methods.github).toBe(true)
    config.enabled.github = false
    expect(publicAuthConfig(config).methods.github).toBe(false)
  })

  it('hides L4 login methods when Cloudflare Access owns the perimeter', () => {
    expect(publicAuthConfig(runtime({ mode: 'access', registrationMode: 'invite_only' }))).toEqual({
      mode: 'access',
      registrationMode: 'open',
      signupEnabled: false,
      emailSignupEnabled: false,
      passwordResetEnabled: false,
      methods: { email: false, github: false, google: false, linkedin: false, twitter: false, telegram: false },
      turnstile: { enabled: false, siteKey: null },
    })
  })

  it('exposes direct email signup for open registration without optional infrastructure', () => {
    const config = runtime({ registrationMode: 'open' })
    expect(publicAuthConfig(config)).toMatchObject({
      signupEnabled: true,
      emailSignupEnabled: true,
      passwordResetEnabled: false,
      turnstile: { enabled: false, siteKey: null },
    })
    expect(emailVerificationRequired(config)).toBe(false)
  })

  it('keeps invite-only email signup available without optional email delivery', () => {
    const config = runtime({
      registrationMode: 'invite_only',
      enabled: { email: true, github: false, google: false, linkedin: false, twitter: false, telegram: false, turnstile: true },
      credentials: { turnstile: { publicKey: 'site', secret: 'secret', source: 'database', secretReadable: true } },
      email: { binding: true, from: 'login@example.com', fromName: 'L4', senderManagedByDeployment: false, verificationReady: true },
    })
    expect(publicAuthConfig(config)).toMatchObject({ signupEnabled: false, emailSignupEnabled: true })
    expect(emailVerificationRequired(config)).toBe(true)
    expect(publicAuthConfig(config).passwordResetEnabled).toBe(true)
    config.email.binding = false
    config.email.verificationReady = false
    expect(publicAuthConfig(config)).toMatchObject({
      signupEnabled: false,
      emailSignupEnabled: true,
      passwordResetEnabled: false,
    })
    expect(emailVerificationRequired(config)).toBe(false)
  })
})
