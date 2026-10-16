import { beforeEach, describe, expect, it, vi } from 'vitest'
import { enableL4Files } from '../../../packages/admin-core/src/storage'
import { parseBaseInstallRequest, updateWorkerBindings } from '../../../packages/admin-core/src/index'

const mocks = vi.hoisted(() => ({ installation: vi.fn(), bucket: vi.fn(), settings: vi.fn(), patch: vi.fn() }))
vi.mock('../../../packages/admin-core/src/installations', () => ({ readL4Installation: mocks.installation }))
vi.mock('../../../packages/admin-core/src/deploy', async (original) => ({ ...await original<object>(), ensureR2: mocks.bucket }))
vi.mock('../../../packages/admin-core/src/cloudflare-client', () => ({ cloudflareClient: () => ({ workers: { scripts: { scriptAndVersionSettings: { get: mocks.settings } } } }) }))
vi.mock('../../../packages/admin-core/src/worker-settings', () => ({ patchWorkerBindings: mocks.patch }))

beforeEach(() => { vi.clearAllMocks() })

describe('optional workspace R2', () => {
  it('carries the explicit no-R2 choice through the base installer', () => {
    expect(parseBaseInstallRequest({ accountId: 'a'.repeat(32), workerName: 'team', appName: 'Team', filesEnabled: false }).filesEnabled).toBe(false)
    expect(parseBaseInstallRequest({ accountId: 'a'.repeat(32), workerName: 'team', appName: 'Team' }).filesEnabled).toBe(true)
  })

  it('adds only FILES and preserves every existing binding, including secrets and DOs', async () => {
    mocks.installation.mockResolvedValue({ resources: { bucketName: null } })
    mocks.bucket.mockResolvedValue('team-files')
    mocks.settings.mockResolvedValue({ bindings: [
      { name: 'DB', type: 'd1', database_id: 'original' },
      { name: 'AUTH_SECRET', type: 'secret_text' },
      { name: 'CHANNEL_DO', type: 'durable_object_namespace' },
      { name: 'LLLL_ADMIN', type: 'service' },
      { name: 'ASSETS', type: 'assets' },
    ] })
    await expect(enableL4Files('token', 'account', 'team')).resolves.toEqual({ bucketName: 'team-files' })
    expect(mocks.patch).toHaveBeenCalledWith('token', 'account', 'team', [
      ...['DB', 'AUTH_SECRET', 'CHANNEL_DO', 'LLLL_ADMIN', 'ASSETS'].map(name => ({ name, type: 'inherit' })),
      { name: 'FILES', type: 'r2_bucket', bucket_name: 'team-files' },
    ])
  })

  it('preserves an existing bucket and never reprovisions it', async () => {
    mocks.installation.mockResolvedValue({ resources: { bucketName: 'existing-files' } })
    await expect(enableL4Files('token', 'account', 'team')).resolves.toEqual({ bucketName: 'existing-files' })
    expect(mocks.bucket).not.toHaveBeenCalled()
    expect(mocks.patch).not.toHaveBeenCalled()
  })

  it('does not provision storage when the Worker is not a L4 workspace', async () => {
    mocks.installation.mockResolvedValue(null)
    await expect(enableL4Files('token', 'account', 'unrelated')).rejects.toMatchObject({ statusCode: 404 })
    expect(mocks.bucket).not.toHaveBeenCalled()
  })

  it('release updates preserve both R2 presence and its absence', () => {
    const manifest = { version: '0.2.2', durableObjects: [] } as Parameters<typeof updateWorkerBindings>[1]
    expect(updateWorkerBindings([{ name: 'FILES', type: 'r2_bucket', bucket_name: 'existing' }], manifest)).toContainEqual({ name: 'FILES', type: 'inherit' })
    expect(updateWorkerBindings([{ name: 'DB', type: 'd1' }], manifest).some(binding => binding.name === 'FILES')).toBe(false)
  })
})
