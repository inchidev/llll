import { describe, expect, it } from 'vitest'
import { ownerSetupTokenMatches, readOwnerSetupEnv, verifyOwnerSetupToken } from '../../server/utils/owner-setup'

describe('owner setup', () => {
  it('needs only a strong installer claim, not an email', () => {
    expect(readOwnerSetupEnv({})).toBeNull()
    expect(readOwnerSetupEnv({ SETUP_TOKEN: 'short' })).toBeNull()
    expect(readOwnerSetupEnv({ SETUP_TOKEN: 'x'.repeat(32) }, 'Example Server')).toEqual({
      username: null,
      token: 'x'.repeat(32),
      serverName: 'Example Server',
    })
  })

  it('takes ADMIN_USERNAME as a suggestion, and ignores one that could not be a username', () => {
    expect(readOwnerSetupEnv({ ADMIN_USERNAME: ' Owner ', SETUP_TOKEN: 'x'.repeat(32) })?.username).toBe('owner')
    expect(readOwnerSetupEnv({ ADMIN_USERNAME: 'owner@example.com', SETUP_TOKEN: 'x'.repeat(32) })?.username).toBeNull()
  })

  it('compares the complete private claim', () => {
    const token = 'claim-token-'.padEnd(40, 'x')
    expect(ownerSetupTokenMatches(token, token)).toBe(true)
    expect(ownerSetupTokenMatches(token, `${token.slice(0, -1)}y`)).toBe(false)
    expect(ownerSetupTokenMatches(token, token.slice(0, -1))).toBe(false)
  })

  it('accepts only the private setup claim', async () => {
    const setup = readOwnerSetupEnv({ SETUP_TOKEN: 'x'.repeat(32) })
    expect(await verifyOwnerSetupToken(setup, 'x'.repeat(32))).toBe(true)
    expect(await verifyOwnerSetupToken(setup, 'y'.repeat(32))).toBe(false)
    expect(await verifyOwnerSetupToken(null, 'x'.repeat(32))).toBe(false)
  })
})
