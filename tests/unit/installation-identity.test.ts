import { describe, expect, it } from 'vitest'
import { signInstallationIdentity, verifyInstallationIdentity } from '../../shared/installation-identity'

const identity = { sub: 'user-a', name: 'Alice', email: 'alice@example.com', role: 'member' as const, sessionId: 'session-a' }
const key = 'a'.repeat(64)

describe('installation identity boundary', () => {
  it('binds a short-lived identity to one installation and one server', async () => {
    const token = await signInstallationIdentity(identity, key, 'https://one.example.com', 'alpha')
    expect(await verifyInstallationIdentity(token, key, 'https://one.example.com', 'alpha')).toEqual(identity)
    await expect(verifyInstallationIdentity(token, key, 'https://one.example.com', 'beta')).rejects.toThrow()
    await expect(verifyInstallationIdentity(token, key, 'https://two.example.com', 'alpha')).rejects.toThrow()
    await expect(verifyInstallationIdentity(token, 'b'.repeat(64), 'https://one.example.com', 'alpha')).rejects.toThrow()
  })
  it('refuses missing or placeholder connection keys', async () => {
    await expect(signInstallationIdentity(identity, 'placeholder', 'https://one.example.com', 'alpha')).rejects.toThrow()
  })
})
