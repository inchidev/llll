import { describe, expect, it } from 'vitest'
import { decryptAuthSecret, encryptAuthSecret } from '../../server/utils/auth-secrets'

describe('auth provider secret encryption', () => {
  it('round-trips a secret without storing plaintext', async () => {
    const encrypted = await encryptAuthSecret('a sufficiently long auth secret', 'github', 'oauth-secret')

    expect(encrypted.ciphertext).not.toContain('oauth-secret')
    await expect(decryptAuthSecret('a sufficiently long auth secret', 'github', encrypted)).resolves.toBe('oauth-secret')
  })

  it('binds ciphertext to the installation key and provider', async () => {
    const encrypted = await encryptAuthSecret('first installation secret', 'twitter', 'oauth-secret')

    await expect(decryptAuthSecret('another installation secret', 'twitter', encrypted)).rejects.toThrow()
    await expect(decryptAuthSecret('first installation secret', 'github', encrypted)).rejects.toThrow()
  })
})
