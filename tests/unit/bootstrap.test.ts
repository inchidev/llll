import { describe, expect, it } from 'vitest'
import { readAdminEnv } from '../../server/utils/bootstrap'

describe('readAdminEnv', () => {
  it('returns null when the username or password is missing or unusable', () => {
    expect(readAdminEnv({})).toBeNull()
    expect(readAdminEnv({ ADMIN_USERNAME: 'admin' })).toBeNull()
    expect(readAdminEnv({ ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'short' })).toBeNull()
    expect(readAdminEnv({ ADMIN_USERNAME: 'admin@example.com', ADMIN_PASSWORD: 'test-password' })).toBeNull()
  })
  it('uses name, then handle, then the username', () => {
    expect(readAdminEnv({
      ADMIN_USERNAME: 'Admin',
      ADMIN_PASSWORD: 'test-password',
      ADMIN_NAME: 'Ada',
      ADMIN_HANDLE: 'ada',
    })).toEqual({
      username: 'admin',
      password: 'test-password',
      handle: 'ada',
      displayName: 'Ada',
      serverName: 'HQ',
    })
    expect(readAdminEnv({ ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'test-password', ADMIN_HANDLE: 'ada' })?.displayName).toBe('ada')
    expect(readAdminEnv({ ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'test-password' })).toMatchObject({ handle: 'admin', displayName: 'admin' })
  })
})
