import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose'
import { describe, expect, it } from 'vitest'
import { authMode, readCloudflareAccessConfig, verifyCloudflareAccessToken } from '../../server/utils/cloudflare-access'

describe('Cloudflare Access configuration', () => {
  it('keeps builtin auth as the backwards-compatible default', () => {
    expect(authMode({})).toBe('builtin')
    expect(authMode({ AUTH_MODE: 'access' })).toBe('access')
  })

  it('accepts a Cloudflare Access issuer and audience', () => {
    expect(readCloudflareAccessConfig({
      CF_ACCESS_ISS: 'https://team.cloudflareaccess.com/',
      CF_ACCESS_AUD: 'audience-tag',
    })).toEqual({ issuer: 'https://team.cloudflareaccess.com', audience: 'audience-tag' })
  })

  it('rejects incomplete or non-Cloudflare issuers', () => {
    expect(() => readCloudflareAccessConfig({ CF_ACCESS_ISS: 'https://example.com', CF_ACCESS_AUD: 'aud' })).toThrow()
    expect(() => readCloudflareAccessConfig({ CF_ACCESS_ISS: 'https://team.cloudflareaccess.com' })).toThrow()
  })

  it('verifies the issuer and audience before exposing an identity', async () => {
    const { privateKey, publicKey } = await generateKeyPair('RS256')
    const jwk = await exportJWK(publicKey)
    const keys = createLocalJWKSet({ keys: [{ ...jwk, kid: 'test', alg: 'RS256', use: 'sig' }] })
    const token = await new SignJWT({ email: 'Owner@Example.com', name: 'Owner' })
      .setProtectedHeader({ alg: 'RS256', kid: 'test' })
      .setIssuer('https://team.cloudflareaccess.com')
      .setAudience('llll-aud')
      .setSubject('access-user')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey)

    await expect(verifyCloudflareAccessToken(token, {
      issuer: 'https://team.cloudflareaccess.com',
      audience: 'llll-aud',
    }, keys)).resolves.toMatchObject({ email: 'owner@example.com', name: 'Owner' })
    await expect(verifyCloudflareAccessToken(token, {
      issuer: 'https://team.cloudflareaccess.com',
      audience: 'another-app',
    }, keys)).rejects.toThrow()
  })
})
