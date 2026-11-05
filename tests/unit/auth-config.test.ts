import { describe, expect, it } from 'vitest'
import { forgetSessionAuthConfig, installedMailboxSender, installedMailboxSenderFromDb, loadSessionAuthConfig, publicAuthConfig, type AuthRuntimeConfig } from '../../server/utils/auth-config'
import { authEmailAvailable } from '../../workers/mail-transport'

function runtime(overrides: Partial<AuthRuntimeConfig> = {}): AuthRuntimeConfig {
  return {
    mode: 'builtin',
    registrationMode: 'invite_only',
    enabled: { password: true, github: false, google: false, linkedin: false, twitter: false, turnstile: false },
    credentials: {},
    email: { binding: false, from: null, fromName: null, senderManagedByDeployment: false, verificationReady: false },
    ...overrides,
  }
}

function database(read: () => Promise<never>) {
  const statement = { bind: () => statement, all: read, first: read, raw: read, run: read }
  return { prepare: () => statement } as unknown as D1Database
}

describe('sender from a connected mail domain', () => {
  function mailDatabase(domains: string[], localPart: string | null = null) {
    const statement = (sql: string) => ({
      bind: () => statement(sql),
      first: async () => (sql.includes('server_settings') && localPart ? { value: localPart } : null),
      all: async () => ({ results: sql.includes('email_domains') ? domains.map(domain => ({ id: domain, zoneId: 'zone', domain, appHostname: 'chat.example.com' })) : [] }),
    })
    return { prepare: statement } as unknown as D1Database
  }

  it('sends from no-reply at the domain without further setup', async () => {
    await expect(installedMailboxSenderFromDb({ DB: mailDatabase(['example.com']) } as never)).resolves.toBe('no-reply@example.com')
  })

  it('keeps a default address the Server already has', async () => {
    await expect(installedMailboxSenderFromDb({ DB: mailDatabase(['example.com'], 'Inbox') } as never)).resolves.toBe('inbox@example.com')
  })

  it('has no sender without a mail domain', async () => {
    await expect(installedMailboxSenderFromDb({ DB: mailDatabase([]) } as never)).resolves.toBeNull()
  })
})

describe('session auth config', () => {
  it('never waits on a read begun by another request, which may have ended', async () => {
    forgetSessionAuthConfig()
    // On Workers the promise of a request that ended never settles.
    void loadSessionAuthConfig({ DB: database(() => new Promise<never>(() => {})) } as never)
    const own = loadSessionAuthConfig({ DB: database(() => Promise.reject(new Error('own read'))) } as never)
    await expect(own).rejects.toThrow()
    forgetSessionAuthConfig()
  })
})

describe('public auth config', () => {
  it.each(['google', 'linkedin'] as const)('gates %s on usable credentials and the owner switch', (provider) => {
    const config = runtime({ registrationMode: 'open' })
    config.enabled.password = false
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
      enabled: { password: true, github: true, google: false, linkedin: false, twitter: false, turnstile: false },
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
      inviteSignupEnabled: false,
      passwordResetEnabled: false,
      methods: { password: false, github: false, google: false, linkedin: false, twitter: false },
      turnstile: { enabled: false, siteKey: null },
    })
  })

  const turnstile = { turnstile: { publicKey: 'site', secret: 'secret', source: 'database' as const, secretReadable: true } }
  const mail = { binding: true, from: 'login@example.com', fromName: 'L4', senderManagedByDeployment: false, verificationReady: true }

  it('lets an invite create a username Account with no mail at all', () => {
    expect(publicAuthConfig(runtime())).toMatchObject({
      signupEnabled: false,
      emailSignupEnabled: false,
      inviteSignupEnabled: true,
      passwordResetEnabled: false,
    })
    expect(publicAuthConfig(runtime({ registrationMode: 'open' }))).toMatchObject({ inviteSignupEnabled: true })
    const off = runtime()
    off.enabled.password = false
    expect(publicAuthConfig(off).inviteSignupEnabled).toBe(false)
  })

  it('opens password sign-up without an invite only with open registration, mail and Turnstile', () => {
    const ready = () => {
      const config = runtime({ registrationMode: 'open', credentials: turnstile, email: { ...mail } })
      config.enabled.turnstile = true
      return config
    }
    expect(publicAuthConfig(ready())).toMatchObject({ signupEnabled: true, emailSignupEnabled: true, passwordResetEnabled: true })

    const noMail = ready()
    noMail.email.verificationReady = false
    expect(publicAuthConfig(noMail)).toMatchObject({ signupEnabled: false, emailSignupEnabled: false, inviteSignupEnabled: true, passwordResetEnabled: false })

    const noTurnstile = ready()
    noTurnstile.enabled.turnstile = false
    expect(publicAuthConfig(noTurnstile)).toMatchObject({ signupEnabled: false, emailSignupEnabled: false, inviteSignupEnabled: true })

    const inviteOnly = ready()
    inviteOnly.registrationMode = 'invite_only'
    expect(publicAuthConfig(inviteOnly)).toMatchObject({ signupEnabled: false, emailSignupEnabled: false, inviteSignupEnabled: true, passwordResetEnabled: true })
  })
})
