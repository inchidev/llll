import { describe, expect, it } from 'vitest'
import { decryptSecret, encryptSecret, hashPassword, verifyPassword } from '../../../apps/admin/server/utils/secrets'
import { compareVersions } from '../../../apps/admin/server/utils/releases'
import { adminRelayState, isAdminRelayTarget, parseAdminRelayState } from '../../../packages/admin-core/src/oauth'

const secret = 'a'.repeat(48)

describe('Admin credential storage', () => {
  it('round-trips a credential encrypted with the Admin secret', async () => {
    const stored = await encryptSecret(secret, 'cloudflare-credential', 'refresh-token')
    expect(stored).not.toContain('refresh-token')
    await expect(decryptSecret(secret, 'cloudflare-credential', stored)).resolves.toBe('refresh-token')
  })

  it('cannot read a credential with another secret or scope', async () => {
    const stored = await encryptSecret(secret, 'cloudflare-credential', 'refresh-token')
    await expect(decryptSecret('b'.repeat(48), 'cloudflare-credential', stored)).rejects.toThrow()
    await expect(decryptSecret(secret, 'cloudflare-access-token', stored)).rejects.toThrow()
  })

  it('refuses a missing or short Admin secret', async () => {
    await expect(encryptSecret('short', 'scope', 'value')).rejects.toThrow('ADMIN_SECRET')
  })

  it('verifies the owner password and nothing else', async () => {
    const hash = await hashPassword('correct horse battery')
    await expect(verifyPassword('correct horse battery', hash)).resolves.toBe(true)
    await expect(verifyPassword('correct horse batterx', hash)).resolves.toBe(false)
    await expect(verifyPassword('anything', 'not-a-hash')).resolves.toBe(false)
  })
})

describe('Admin OAuth relay', () => {
  it('only forwards codes to a L4 Admin on workers.dev', () => {
    expect(isAdminRelayTarget('llll-admin.team.workers.dev')).toBe(true)
    expect(isAdminRelayTarget('llll-admin.team.workers.dev.evil.com')).toBe(false)
    expect(isAdminRelayTarget('evil.team.workers.dev')).toBe(false)
    expect(isAdminRelayTarget('llll-admin.example.com')).toBe(false)
  })

  it('carries the Admin hostname and its own nonce in the state', () => {
    const nonce = 'n'.repeat(32)
    const state = adminRelayState('LLLL-Admin.Team.workers.dev', nonce)
    expect(parseAdminRelayState(state)).toEqual({ hostname: 'llll-admin.team.workers.dev', nonce })
    expect(parseAdminRelayState(`evil.com~${nonce}`)).toBeNull()
    expect(parseAdminRelayState('llll-admin.team.workers.dev~short')).toBeNull()
  })
})

describe('Admin release ordering', () => {
  it('orders releases numerically and pre-releases before their release', () => {
    expect(compareVersions('0.2.0', '0.1.9')).toBe(1)
    expect(compareVersions('0.10.0', '0.9.9')).toBe(1)
    expect(compareVersions('v0.2.0', '0.2.0')).toBe(0)
    expect(compareVersions('0.2.0-rc.1', '0.2.0')).toBe(-1)
    expect(compareVersions('0.1.9', '0.2.0')).toBe(-1)
  })
})
