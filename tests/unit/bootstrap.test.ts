import { describe, expect, it } from 'vitest'
import { readAdminEnv } from '../../server/utils/bootstrap'

describe('readAdminEnv', () => {
  it('returns null when email or password is missing', () => {
    expect(readAdminEnv({})).toBeNull()
    expect(readAdminEnv({ ADMIN_EMAIL: 'admin@example.com' })).toBeNull()
    expect(readAdminEnv({ ADMIN_EMAIL: 'admin@example.com', ADMIN_PASSWORD: 'short' })).toBeNull()
  })
  it('uses name, then handle, then the email local-part', () => {
    expect(readAdminEnv({
      ADMIN_EMAIL: 'admin@example.com',
      ADMIN_PASSWORD: 'test-password',
      ADMIN_NAME: 'Ada',
      ADMIN_HANDLE: 'ada',
    })).toEqual({
      email: 'admin@example.com',
      password: 'test-password',
      handle: 'ada',
      displayName: 'Ada',
      workspaceName: 'HQ',
    })
    expect(readAdminEnv({
      ADMIN_EMAIL: 'admin@example.com',
      ADMIN_PASSWORD: 'test-password',
      ADMIN_HANDLE: 'ada',
    })?.displayName).toBe('ada')
    expect(readAdminEnv({
      ADMIN_EMAIL: 'admin@example.com',
      ADMIN_PASSWORD: 'test-password',
    })).toMatchObject({ handle: 'admin', displayName: 'admin' })
  })
})
