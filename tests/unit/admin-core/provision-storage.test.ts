import { describe, expect, it, vi } from 'vitest'
import { provisionWorkspaceStorage } from '../../../packages/admin-core/src/deploy'

describe('fresh workspace storage', () => {
  function client() {
    return {
      d1: { database: { list: () => [], create: vi.fn(async () => ({ uuid: 'database' })) } },
      kv: { namespaces: { list: () => [], create: vi.fn(async () => ({ id: 'tickets' })) } },
      r2: { buckets: { list: vi.fn(async () => ({ buckets: [] })), create: vi.fn(async () => ({})) } },
    }
  }

  it('never calls R2 for a fresh install without file storage', async () => {
    const cf = client()
    cf.r2.buckets.list.mockRejectedValue(new Error('R2 is not enabled on this account'))
    await expect(provisionWorkspaceStorage(cf as never, { accountId: 'account', workerName: 'team', filesEnabled: false }, { exists: false })).resolves.toEqual({ databaseId: 'database', kvId: 'tickets', bucketName: undefined })
    expect(cf.r2.buckets.list).not.toHaveBeenCalled()
    expect(cf.r2.buckets.create).not.toHaveBeenCalled()
  })

  it('provisions a workspace bucket when the owner explicitly enables files', async () => {
    const cf = client()
    await expect(provisionWorkspaceStorage(cf as never, { accountId: 'account', workerName: 'team', filesEnabled: true }, { exists: false })).resolves.toMatchObject({ bucketName: 'team-files' })
    expect(cf.r2.buckets.create).toHaveBeenCalledWith({ account_id: 'account', name: 'team-files' })
  })

  it('preserves existing storage regardless of the creation toggle', async () => {
    const cf = client()
    await expect(provisionWorkspaceStorage(cf as never, { accountId: 'account', workerName: 'team', filesEnabled: false }, { exists: true, databaseId: 'original', kvId: 'original-kv', bucketName: 'original-files' })).resolves.toEqual({ databaseId: 'original', kvId: 'original-kv', bucketName: 'original-files' })
    expect(cf.r2.buckets.list).not.toHaveBeenCalled()
    expect(cf.d1.database.create).not.toHaveBeenCalled()
  })
})
