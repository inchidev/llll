import { beforeEach, expect, it, vi } from 'vitest'
import { emptyUpdateRecord, type ServerUpdateRecord } from '../../shared/server-updates'

const state = vi.hoisted(() => ({ record: null as unknown as ServerUpdateRecord, revision: 0, version: '0.3.1', upload: vi.fn(), verify: vi.fn() }))
vi.mock('../../server/utils/server-updates', () => ({
  updateStorage: () => ({
    read: async () => ({ value: structuredClone(state.record), revision: state.revision }),
    write: async (value: ServerUpdateRecord, revision: number | null) => { if (revision !== state.revision) return false; state.record = structuredClone(value); state.revision++; return true },
  }),
  serverDeployment: async () => ({ accountId: 'a'.repeat(32), workerName: 'llll-server', site: 'https://llll.gg', origin: 'https://server.example' }),
}))
vi.mock('../../shared/server-id', () => ({ getServerId: async () => 'server-id' }))
vi.mock('../../server/utils/version', () => ({ serverVersion: () => state.version }))
vi.mock('../../server/utils/db', () => ({ ensureMigrated: async () => true }))
vi.mock('../../server/utils/cloudflare-account-access', () => ({ cloudflareAccessToken: async () => ({ token: 'cf-token', accountId: 'a'.repeat(32) }) }))
vi.mock('../../packages/deployment-core/src/installer', () => ({ updateL4: (...args: unknown[]) => state.upload(...args) }))
vi.mock('../../packages/deployment-core/src/release', () => ({ verifyPublishedRelease: (...args: unknown[]) => state.verify(...args) }))
vi.mock('../../server/utils/server-backup', () => ({ createServerBackup: () => new Blob(['archive']).stream() }))

const { advanceSelfUpdate } = await import('../../server/utils/server-self-update')
const backups = new Map<string, Uint8Array>()
const env = {
  DB: { prepare: () => ({ bind: () => ({ first: async () => null }) }) },
  BACKUPS: {
    createMultipartUpload: async (key: string) => {
      const parts: Uint8Array[] = []
      return {
        uploadPart: async (partNumber: number, bytes: Uint8Array) => { parts.push(bytes.slice()); return { partNumber, etag: String(partNumber) } },
        complete: async () => { backups.set(key, new Uint8Array(await new Blob(parts).arrayBuffer())) },
        abort: async () => {},
      }
    },
    get: async (key: string) => { const bytes = backups.get(key); return bytes ? { size: bytes.byteLength, body: new Blob([bytes]).stream() } : null },
  },
} as never
const counters = new Map<string, number>()
const runner = { attempts: { get: async (key: string) => counters.get(key), put: async (key: string, value: number) => { counters.set(key, value) } }, watchdog: vi.fn(async () => {}) }
beforeEach(() => {
  counters.clear(); backups.clear(); state.revision = 0; state.version = '0.3.1'; state.upload.mockReset(); state.verify.mockReset()
  const now = new Date().toISOString()
  state.record = { ...emptyUpdateRecord(), backupToken: 'b'.repeat(64), job: { id: '11111111-1111-4111-8111-111111111111', serverId: 'server-id', requestedBy: 'owner', sourceVersion: '0.3.1', targetVersion: '0.3.2', stage: 'backing_up', buildId: 'server-run', createdAt: now, updatedAt: now, backup: null, error: null } }
})

it('backs up, uploads and lets the new version finish the job', async () => {
  expect(await advanceSelfUpdate(env, runner)).toBe(0)
  expect(state.verify).toHaveBeenCalledWith('0.3.2')
  expect(state.record.job).toMatchObject({ stage: 'updating', backup: { verified: true, destination: 'bucket' } })
  expect(await advanceSelfUpdate(env, runner)).toBe(15_000)
  expect(runner.watchdog).toHaveBeenCalled()
  expect(state.upload).toHaveBeenCalledWith('cf-token', { accountId: 'a'.repeat(32), workerName: 'llll-server', targetVersion: '0.3.2' }, { verify: false })
  expect(state.record.job?.stage).toBe('verifying')
  // The old code keeps waiting; the new version completes and clears the capability.
  expect(await advanceSelfUpdate(env, runner)).toBe(15_000)
  state.version = '0.3.2'
  expect(await advanceSelfUpdate(env, runner)).toBeNull()
  expect(state.record).toMatchObject({ job: { stage: 'complete', error: null }, backupToken: null })
})

it('stops before deployment when the release cannot be verified', async () => {
  state.verify.mockRejectedValue(new Error('The release manifest checksum did not match'))
  expect(await advanceSelfUpdate(env, runner)).toBeNull()
  expect(state.record.job).toMatchObject({ stage: 'failed', error: 'The release manifest checksum did not match' })
  expect(state.upload).not.toHaveBeenCalled()
})

it('asks for attention after a failed upload and never runs installer jobs', async () => {
  state.record.job!.stage = 'updating'
  state.upload.mockRejectedValue(new Error('Cloudflare upload failed'))
  expect(await advanceSelfUpdate(env, runner)).toBeNull()
  expect(state.record.job).toMatchObject({ stage: 'attention', error: 'Cloudflare upload failed' })
  state.record.job = { ...state.record.job!, stage: 'updating', buildId: '22222222-2222-4222-8222-222222222222' }
  expect(await advanceSelfUpdate(env, runner)).toBeNull()
  expect(state.upload).toHaveBeenCalledTimes(1)
})
