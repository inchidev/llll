import { describe, expect, it, vi } from 'vitest'
import { createAuth } from '../../server/utils/better-auth'
import type { AuthRuntimeConfig } from '../../server/utils/auth-config'

describe('social provider admission', () => {
  it.each(['google', 'linkedin'] as const)('keeps %s implicit signup disabled and requests only identity scopes', async (provider) => {
    const config: AuthRuntimeConfig = {
      mode: 'builtin', registrationMode: 'invite_only',
      enabled: { email: true, github: false, google: false, twitter: false, telegram: false, linkedin: false, turnstile: false },
      credentials: {},
      email: { binding: false, from: null, fromName: null, senderManagedByDeployment: false, verificationReady: false },
    }
    config.enabled[provider] = true
    config.credentials[provider] = { publicKey: 'test-client', secret: 'test-secret', source: 'database', secretReadable: true }
    const auth = await createAuth({ DB: {}, AUTH_SECRET: 'test-only-secret-that-is-long-enough' } as never, 'http://localhost:3000', undefined, config)
    expect(auth.options.socialProviders?.[provider]).toEqual({ clientId: 'test-client', clientSecret: 'test-secret', disableImplicitSignUp: true })
    // Use the installed provider implementation to verify its generated request.
    const context = await auth.$context
    const social = context.socialProviders.find(item => item.id === provider)!
    const url = await social.createAuthorizationURL({ state: 'test-state', codeVerifier: 'test-verifier', redirectURI: `http://localhost:3000/api/auth/callback/${provider}` })
    expect(new Set(url.searchParams.get('scope')?.split(' '))).toEqual(new Set(['openid', 'profile', 'email']))
    expect(url.searchParams.get('redirect_uri')).toBe(`http://localhost:3000/api/auth/callback/${provider}`)
    expect(auth.options.account?.accountLinking?.trustedProviders).toBeUndefined()
    expect(context.trustedProviders).not.toContain(provider)
  })

  it('does not turn an unverified LinkedIn address into a verified identity', async () => {
    const config: AuthRuntimeConfig = {
      mode: 'builtin', registrationMode: 'invite_only',
      enabled: { email: true, github: false, google: false, twitter: false, telegram: false, linkedin: true, turnstile: false },
      credentials: { linkedin: { publicKey: 'test-client', secret: 'test-secret', source: 'database', secretReadable: true } },
      email: { binding: false, from: null, fromName: null, senderManagedByDeployment: false, verificationReady: false },
    }
    const auth = await createAuth({ DB: {}, AUTH_SECRET: 'test-only-secret-that-is-long-enough' } as never, 'http://localhost:3000', undefined, config)
    const context = await auth.$context
    const social = context.socialProviders.find(item => item.id === 'linkedin')!
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ sub: 'linkedin-member', name: 'Member', email: 'member@example.test', email_verified: false })))
    try {
      const profile = await social.getUserInfo({ accessToken: 'test-only-token' })
      expect(profile?.user.emailVerified).toBe(false)
      expect(context.trustedProviders).not.toContain('linkedin')
    }
    finally {
      vi.unstubAllGlobals()
    }
  })
})
