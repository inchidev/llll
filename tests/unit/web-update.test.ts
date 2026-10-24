import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { advanceUpdate, failUpdate, prepareUpdate, publicUpdate, rememberUpdate, verifyRelease } from '../../apps/site/src/update'
import type { DeploymentState, UpdateState } from '../../apps/site/src/session'
import { readL4Server } from '../../packages/deployment-core/src/servers'
import type { CloudflareServer } from '../../packages/deployment-core/src/types'

const accountId = 'a'.repeat(32)
const serverId = '11111111-1111-4111-8111-111111111111'
const jobId = '22222222-2222-4222-8222-222222222222'
const token = 'b'.repeat(64)
const now = new Date().toISOString()
let recordValue = record()
let revisionValue = 0

vi.mock('../../packages/deployment-core/src/servers', () => ({ readL4Server: vi.fn() }))
afterEach(() => { vi.unstubAllGlobals(); vi.mocked(readL4Server).mockReset() })

function tarEntry(name: string, data: Uint8Array) {
  const header = new Uint8Array(512)
  const encoder = new TextEncoder()
  header.set(encoder.encode(name).subarray(0, 100))
  header.set(encoder.encode('0000644\0'), 100)
  header.set(encoder.encode('0000000\0'), 108)
  header.set(encoder.encode('0000000\0'), 116)
  header.set(encoder.encode(data.length.toString(8).padStart(11, '0') + '\0'), 124)
  header.set(encoder.encode('00000000000\0'), 136)
  header.set(encoder.encode('        '), 148)
  header[156] = 0x30
  let checksum = 0
  for (const byte of header) checksum += byte
  header.set(encoder.encode(checksum.toString(8).padStart(6, '0') + '\0 '), 148)
  const padding = new Uint8Array((512 - (data.length % 512)) % 512)
  const out = new Uint8Array(512 + data.length + padding.length)
  out.set(header)
  out.set(data, 512)
  out.set(padding, 512 + data.length)
  return out
}

function archive() {
  const encoder = new TextEncoder()
  const summary = encoder.encode(JSON.stringify({ completedAt: now, tables: 2, databaseRows: 3, r2Objects: 1, r2Bytes: 6 }))
  const meta = encoder.encode(JSON.stringify({ key: 'hello.txt', size: 6, etag: 'abcdefabcdefabcdefabcdefabcdef12' }))
  const entries = [
    tarEntry('summary.json', summary),
    tarEntry('r2/00000001.json', meta),
    tarEntry('r2/00000001.bin', encoder.encode('hello\n')),
  ]
  const total = entries.reduce((size, entry) => size + entry.length, 0) + 1024
  const out = new Uint8Array(total)
  let offset = 0
  for (const entry of entries) { out.set(entry, offset); offset += entry.length }
  return out
}

function record() {
  return {
    schemaVersion: 1,
    hook: null,
    backupToken: token,
    backupBusy: false,
    job: {
      id: jobId,
      serverId,
      requestedBy: '33333333-3333-4333-8333-333333333333',
      sourceVersion: '0.2.4',
      targetVersion: '0.2.5',
      stage: 'backing_up',
      buildId: null,
      createdAt: now,
      updatedAt: now,
      backup: null,
      error: null,
    },
  }
}

function update(): UpdateState {
  return {
    origin: 'https://server.test',
    accountId,
    workerName: 'l4-server',
    jobId,
    serverId,
    databaseId: 'db-id',
    filesBucket: 'files',
    backupBucket: 'backups',
    installedVersion: '0.2.4',
    targetVersion: '0.2.5',
    executorId: crypto.randomUUID(),
    phase: 'backup',
  }
}

function d1(sql: string, params: (string | number)[]) {
  if (sql.includes('SELECT payload, revision FROM server_update_control'))
    return [{ payload: JSON.stringify(recordValue), revision: revisionValue }]
  if (sql.startsWith('UPDATE server_update_control')) {
    recordValue = JSON.parse(String(params[0]))
    revisionValue += 1
    return [{ revision: revisionValue }]
  }
  if (sql === 'PRAGMA table_list')
    return [
      { name: 'server', type: 'table' },
      { name: 'message_search', type: 'virtual' },
      { name: 'message_search_data', type: 'shadow' },
      { name: 'sqlite_sequence', type: 'table' },
    ]
  if (sql.includes('FROM "server"')) return [{ count: 1 }]
  if (sql.includes('FROM "message_search"')) return [{ count: 2 }]
  throw new Error(`Unexpected SQL: ${sql}`)
}

function stubUpdateFetch(bytes: Uint8Array, sha256: string) {
  const requests: { url: string; init?: RequestInit }[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    requests.push({ url: url.toString(), init })
    if (url.hostname === 'api.cloudflare.com' && url.pathname.endsWith('/query')) {
      const body = JSON.parse(String(init?.body)) as { sql: string; params: (string | number)[] }
      return Response.json({ success: true, result: [{ success: true, results: d1(body.sql, body.params || []) }] })
    }
    if (url.pathname.includes('/r2/buckets/backups/objects/')) return new Response(bytes)
    if (url.pathname.includes('/r2/buckets/files/objects')) {
      return Response.json({ success: true, result: [{ size: 6 }], result_info: { is_truncated: false } })
    }
    if (url.hostname === 'server.test' && url.pathname.endsWith('/updates/backup')) {
      recordValue.job.backup = {
        key: `servers/${serverId}/pre-update/${jobId}/backup.tar`,
        bucket: 'backups',
        sizeBytes: bytes.byteLength,
        sha256,
        createdAt: now,
        verified: false,
      }
      recordValue.backupBusy = false
      return Response.json({ backup: recordValue.job.backup })
    }
    throw new Error(`Unexpected request: ${url}`)
  }))
  return requests
}

describe('web update executor', () => {
  it('normalizes an update request and refuses non-HTTPS origins', async () => {
    const state: DeploymentState = {}
    await expect(rememberUpdate(state, { origin: 'https://server.test', accountId, workerName: 'l4-server', jobId })).resolves.toMatchObject({ origin: 'https://server.test', jobId })
    await expect(rememberUpdate(state, { origin: 'http://server.test', accountId, workerName: 'l4-server', jobId })).rejects.toThrow('HTTPS')
    await expect(rememberUpdate(state, { origin: 'https://server.test/path', accountId, workerName: 'l4-server', jobId })).rejects.toThrow('HTTPS')
  })

  it('exposes progress without leaking backup credentials', () => {
    const state: DeploymentState = { update: { ...update(), backup: { key: 'secret/key', bucket: 'backups', sizeBytes: 12, sha256: 'c'.repeat(64), createdAt: now, verified: true } } }
    const value = publicUpdate(state)!
    expect(value).toMatchObject({ jobId, targetVersion: '0.2.5', backup: { verified: true } })
    expect(JSON.stringify(value)).not.toContain('secret/key')
    expect(JSON.stringify(value)).not.toContain(token)
  })

  it('verifies the published manifest against SHA256SUMS before an update', async () => {
    const manifest = JSON.stringify({ version: '0.2.6', capabilities: ['llll-server-schema-v1'] })
    const hash = createHash('sha256').update(manifest).digest('hex')
    vi.stubGlobal('fetch', vi.fn(async (input: string) => input.endsWith('/SHA256SUMS')
      ? new Response(`${hash}  llll-cloudflare-manifest.json\n`)
      : new Response(manifest)))
    await expect(verifyRelease('0.2.6')).resolves.toBeUndefined()
  })

  it('rejects a manifest that does not match the published checksum', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string) => input.endsWith('/SHA256SUMS')
      ? new Response(`${'0'.repeat(64)}  llll-cloudflare-manifest.json\n`)
      : new Response(JSON.stringify({ version: '0.2.6', capabilities: ['llll-server-schema-v1'] }))))
    await expect(verifyRelease('0.2.6')).rejects.toThrow('checksum')
  })

  it('creates and verifies a backup in the separate bucket before deployment', async () => {
    recordValue = record()
    revisionValue = 0
    const bytes = archive()
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const requests = stubUpdateFetch(bytes, sha256)
    const state: DeploymentState = { update: update() }
    await advanceUpdate(state, 'api-token', async () => {})
    expect(state.update?.phase).toBe('deploy')
    expect(state.update?.backup?.verified).toBe(true)
    expect(recordValue.job.backup.verified).toBe(true)
    const backupCall = requests.find(item => item.url.endsWith('/updates/backup'))
    expect(backupCall?.init?.headers).toMatchObject({ Authorization: `Bearer ${token}` })
    expect(JSON.parse(String(backupCall?.init?.body))).toMatchObject({ requestId: jobId, buildId: state.update?.executorId })
  })

  it('does not deploy when the archive checksum does not match', async () => {
    recordValue = record()
    revisionValue = 0
    const bytes = archive()
    const requests = stubUpdateFetch(bytes, 'd'.repeat(64))
    const state: DeploymentState = { update: update() }
    await expect(advanceUpdate(state, 'api-token', async () => {})).rejects.toThrow('checksum')
    expect(state.update?.phase).toBe('backup')
    expect(recordValue.job.backup).toBeNull()
    expect(requests.some(item => item.url.includes('/workers/scripts/'))).toBe(false)
  })

  it('marks a failed backup as failed without claiming deployment', async () => {
    recordValue = record()
    revisionValue = 0
    const bytes = archive()
    stubUpdateFetch(bytes, createHash('sha256').update(bytes).digest('hex'))
    const state: DeploymentState = { update: update() }
    state.update!.error = 'The pre-update backup did not complete.'
    await failUpdate(state, 'api-token')
    expect(recordValue.job.stage).toBe('failed')
    expect(recordValue.job.error).toContain('backup')
  })
})

describe('update preparation', () => {
  const server = {
    origin: 'https://server.test',
    resources: { databaseId: 'db-id', bucketName: 'files', backupBucketName: 'backups' },
  } as unknown as CloudflareServer

  function prepareFetch(version: string) {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      if (url.hostname === 'server.test' && url.pathname === '/.well-known/llll')
        return Response.json({ product: 'llll', kind: 'server', id: serverId, origin: 'https://server.test', version })
      if (url.pathname.endsWith('/query')) {
        const body = JSON.parse(String(init?.body)) as { sql: string; params: (string | number)[] }
        return Response.json({ success: true, result: [{ success: true, results: d1(body.sql, body.params || []) }] })
      }
      throw new Error(`Unexpected request: ${url}`)
    }))
  }

  it('resumes a post-deployment failure at health verification when the target is already installed', async () => {
    const state: DeploymentState = {}
    const value = record()
    value.job.stage = 'attention'
    value.job.sourceVersion = '0.2.4'
    value.job.targetVersion = '0.2.5'
    value.job.backup = { key: `servers/${serverId}/pre-update/${jobId}/backup.tar`, bucket: 'backups', sizeBytes: 2048, sha256: 'e'.repeat(64), createdAt: now, verified: true }
    recordValue = value
    revisionValue = 0
    vi.mocked(readL4Server).mockResolvedValue(server)
    prepareFetch('0.2.5')
    const update = await prepareUpdate(state, { origin: 'https://server.test', accountId, workerName: 'l4-server', jobId }, 'api-token')
    expect(update.phase).toBe('verify')
    expect(update.installedVersion).toBe('0.2.5')
  })

  it('resumes a verified downloaded backup from D1 across fresh installer sessions without R2', async () => {
    recordValue = record()
    recordValue.job.stage = 'queued'
    const backup = { destination: 'download' as const, key: 'llll-backup.tar', bucket: '', sizeBytes: 173056, sha256: 'e'.repeat(64), createdAt: now, verified: true }
    recordValue.job.backup = backup
    revisionValue = 0
    vi.mocked(readL4Server).mockResolvedValue({ ...server, resources: { databaseId: 'db-id', bucketName: '', backupBucketName: '' } })
    prepareFetch('0.2.4')
    const state: DeploymentState = {}
    const prepared = await prepareUpdate(state, { origin: 'https://server.test', accountId, workerName: 'l4-server', jobId }, 'api-token')
    expect(prepared.phase).toBe('deploy')
    expect(prepared.backup).toEqual(backup)
    // A stale browser may still be at backup; the persisted receipt is authoritative.
    state.update!.phase = 'backup'
    await advanceUpdate(state, 'api-token', async () => {})
    expect(state.update!.phase).toBe('deploy')
    expect(state.update!.backup).toEqual(backup)
    expect(recordValue.job.backup).toEqual(backup)
    recordValue.job.backup = { ...backup, verified: false }
    state.update!.phase = 'backup'
    await expect(advanceUpdate(state, 'api-token', async () => {})).rejects.toThrow('Download the pre-update backup')
  })

  it('restarts a failed pre-deployment request from release verification', async () => {
    const state: DeploymentState = {}
    const value = record()
    value.job.stage = 'failed'
    value.job.sourceVersion = '0.2.4'
    value.job.targetVersion = '0.2.5'
    value.job.backup = null
    recordValue = value
    revisionValue = 0
    vi.mocked(readL4Server).mockResolvedValue(server)
    prepareFetch('0.2.4')
    const update = await prepareUpdate(state, { origin: 'https://server.test', accountId, workerName: 'l4-server', jobId }, 'api-token')
    expect(update.phase).toBe('release')
  })
})
