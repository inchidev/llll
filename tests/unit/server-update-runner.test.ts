import { describe, expect, it, vi } from 'vitest'
import { activeUpdate, changeUpdateRecord, emptyUpdateRecord, requestServerUpdate, updateHookId, type ServerUpdateJob, type UpdateStore } from '../../shared/server-updates'
import { executeServerUpdate } from '../../shared/server-update-runner'
import { compareVersions } from '../../shared/release-version'

const uuid = '11111111-1111-4111-8111-111111111111'
function job(): ServerUpdateJob { return { id: uuid, serverId: 'server', requestedBy: 'owner', sourceVersion: '0.2.1', targetVersion: '0.2.2', stage: 'queued', buildId: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), backup: null, error: null } }
function memory(initial = emptyUpdateRecord()) {
  let value = structuredClone(initial), revision = 0
  const store: UpdateStore = {
    async read() { return { value: structuredClone(value), revision } },
    async write(next, expected) { if (expected !== revision) return false; value = structuredClone(next); revision++; return true },
  }
  return { store, get value() { return value } }
}
function fixture() {
  const state = emptyUpdateRecord(); requestServerUpdate(state, job())
  const data = memory(state), order: string[] = []
  const backup = { key: 'private/backup.tar', bucket: 'separate-backups', sizeBytes: 512, sha256: 'a'.repeat(64), createdAt: new Date().toISOString(), verified: true }
  return { data, order, deps: {
    store: data.store, serverId: 'server', buildId: 'build-1',
    installedVersion: vi.fn(async () => '0.2.1'), previousBuildStopped: vi.fn(async () => true),
    prepare: vi.fn(async () => { order.push('release') }),
    backup: vi.fn(async () => { order.push('backup'); return backup }),
    deploy: vi.fn(async () => { order.push('deploy') }),
    verify: vi.fn(async () => { order.push('verify') }),
  } }
}
describe('Server update requests and capabilities', () => {
  it('accepts only the canonical Cloudflare hook endpoint, never arbitrary URLs', () => {
    expect(updateHookId(`https://api.cloudflare.com/client/v4/workers/builds/deploy_hooks/${uuid}`)).toBe(uuid)
    for (const bad of [`https://evil.example/${uuid}`, `https://api.cloudflare.com.evil.example/client/v4/workers/builds/deploy_hooks/${uuid}`, `http://api.cloudflare.com/client/v4/workers/builds/deploy_hooks/${uuid}`, `https://api.cloudflare.com/client/v4/workers/builds/deploy_hooks/${uuid}?secret=x`]) expect(() => updateHookId(bad)).toThrow()
  })
  it('serializes concurrent requests and deduplicates retries without changing the backup capability', async () => {
    const data = memory()
    const requests = await Promise.allSettled([uuid, '22222222-2222-4222-8222-222222222222'].map(id => changeUpdateRecord(data.store, state => requestServerUpdate(state, { ...job(), id }))))
    expect(requests.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    const token = data.value.backupToken
    await changeUpdateRecord(data.store, state => requestServerUpdate(state, { ...data.value.job! }))
    expect(data.value.backupToken).toBe(token)
    expect(token).toMatch(/^[a-f0-9]{64}$/)
    expect(() => requestServerUpdate(data.value, { ...data.value.job!, targetVersion: '0.3.0' })).toThrow()
  })
  it('compares alpha-to-stable and high patch versions without lexical ordering', () => {
    expect(compareVersions('v0.2.1', '0.2.0-alpha.8')).toBeGreaterThan(0)
    expect(compareVersions('0.2.600', '0.2.99')).toBeGreaterThan(0)
    expect(compareVersions('0.2.2', '0.2.2-alpha.1')).toBeGreaterThan(0)
  })
})
describe('Git Build update runner', () => {
  it('verifies the published release and persisted backup before deployment, then clears the one-job token', async () => {
    const f = fixture()
    await expect(executeServerUpdate(f.deps)).resolves.toBe(true)
    expect(f.order).toEqual(['release', 'backup', 'deploy', 'verify'])
    expect(f.data.value.job).toMatchObject({ stage: 'complete', buildId: 'build-1', backup: { verified: true } })
    expect(f.data.value.backupToken).toBeNull()
  })
  it('never deploys after a missing, corrupt or unverified backup', async () => {
    for (const failure of ['throw', 'unverified']) {
      const f = fixture()
      f.deps.backup.mockImplementation(async () => { if (failure === 'throw') throw Error('bad archive'); return { key: 'x', bucket: 'b', sha256: 'a'.repeat(64), sizeBytes: 1, createdAt: '', verified: false } })
      await expect(executeServerUpdate(f.deps)).rejects.toThrow()
      expect(f.deps.deploy).not.toHaveBeenCalled()
      expect(f.data.value.job!.stage).toBe('failed')
    }
  })
  it('allows only one Build to claim an update', async () => {
    const f = fixture()
    await Promise.all([executeServerUpdate(f.deps), executeServerUpdate({ ...f.deps, buildId: 'build-2' })])
    expect(f.deps.backup).toHaveBeenCalledTimes(1)
    expect(f.deps.deploy).toHaveBeenCalledTimes(1)
  })
  it('recovers a cancelled Build during backup only after verifying it stopped', async () => {
    const f = fixture()
    await changeUpdateRecord(f.data.store, r => { r.job!.stage = 'backing_up'; r.job!.buildId = 'old-build'; r.backupBusy = true })
    f.deps.previousBuildStopped.mockResolvedValue(false)
    await expect(executeServerUpdate(f.deps)).rejects.toThrow()
    expect(f.deps.backup).not.toHaveBeenCalled()
    f.deps.previousBuildStopped.mockResolvedValue(true)
    await expect(executeServerUpdate(f.deps)).resolves.toBe(true)
    expect(f.data.value.job!.stage).toBe('complete')
  })
  it('fails closed on Server mismatch, downgrade and absent requests', async () => {
    const f = fixture()
    await expect(executeServerUpdate({ ...f.deps, serverId: 'foreign' })).rejects.toThrow()
    expect(f.deps.deploy).not.toHaveBeenCalled()
    f.deps.installedVersion.mockResolvedValue('0.3.0')
    await expect(executeServerUpdate(f.deps)).rejects.toThrow()
    expect(f.deps.backup).not.toHaveBeenCalled()
    await expect(executeServerUpdate({ ...f.deps, store: memory().store })).resolves.toBe(false)
  })
  it('keeps ambiguous deployment failures locked and reconciles only after that Build stops', async () => {
    const f = fixture()
    f.deps.verify.mockRejectedValueOnce(Error('network unavailable'))
    await expect(executeServerUpdate(f.deps)).rejects.toThrow()
    expect(f.data.value.job!.stage).toBe('attention')
    expect(activeUpdate(f.data.value.job)).toBe(true)
    await expect(changeUpdateRecord(f.data.store, r => requestServerUpdate(r, { ...job(), id: 'another' }))).rejects.toThrow()
    f.deps.previousBuildStopped.mockResolvedValue(false)
    await expect(executeServerUpdate({ ...f.deps, buildId: 'build-2' })).rejects.toThrow()
    f.deps.previousBuildStopped.mockResolvedValue(true)
    f.deps.installedVersion.mockResolvedValue('0.2.2')
    await expect(executeServerUpdate({ ...f.deps, buildId: 'build-2' })).resolves.toBe(true)
    expect(f.deps.deploy).toHaveBeenCalledTimes(1)
    expect(f.data.value.job!.stage).toBe('complete')
  })
})
