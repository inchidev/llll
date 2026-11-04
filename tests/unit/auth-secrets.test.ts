import { describe, expect, it } from 'vitest'
import { decryptAuthSecret, encryptAuthSecret } from '../../server/utils/auth-secrets'

describe('auth provider secret encryption', () => {
  it('round-trips a secret without storing plaintext', async () => {
    const encrypted = await encryptAuthSecret('a sufficiently long auth secret', 'github', 'oauth-secret')

    expect(encrypted.ciphertext).not.toContain('oauth-secret')
    await expect(decryptAuthSecret('a sufficiently long auth secret', 'github', encrypted)).resolves.toBe('oauth-secret')
  })

  it('binds ciphertext to the server key and provider', async () => {
    const encrypted = await encryptAuthSecret('first server secret', 'twitter', 'oauth-secret')

    await expect(decryptAuthSecret('another server secret', 'twitter', encrypted)).rejects.toThrow()
    await expect(decryptAuthSecret('first server secret', 'github', encrypted)).rejects.toThrow()
  })
})
