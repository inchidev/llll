import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { digest, type DeploymentState, type DomainRequest } from '../../apps/site/src/session'
import { applyDomainChange, publicDomainRequest, rememberDomainRequest } from '../../apps/site/src/domains'
import { queryRows } from '../../apps/site/src/update'
import {
  connectAppDomain,
  disconnectAppDomain,
  findAppDomain,
  findAppDomainZone,
  setPrimaryAppDomain,
} from '../../packages/deployment-core/src/domains'
import { readL4Server } from '../../packages/deployment-core/src/servers'

vi.mock('../../apps/site/src/update', () => ({ queryRows: vi.fn() }))
vi.mock('../../packages/deployment-core/src/domains', () => ({
  connectAppDomain: vi.fn(),
  disconnectAppDomain: vi.fn(),
  findAppDomain: vi.fn(),
  findAppDomainZone: vi.fn(),
  setPrimaryAppDomain: vi.fn(),
}))
vi.mock('../../packages/deployment-core/src/servers', () => ({ readL4Server: vi.fn() }))

const accountId = 'a'.repeat(32)
const workerName = 'l4-server'
const requestId = '22222222-2222-4222-8222-222222222222'
const serverId = '11111111-1111-4111-8111-111111111111'
const token = 'b'.repeat(64)
const primary = { origin: 'https://primary.example.com', hostname: 'primary.example.com', primary: 1 }
let origins: typeof primary[] = []
let requestRow: Record<string, unknown> = {}

function request(overrides: Partial<DomainRequest> = {}): DomainRequest {
  return {
    origin: primary.origin,
    accountId,
    workerName,
    requestId,
    token,
    action: 'add',
    hostname: 'alias.example.com',
    serverId,
    ...overrides,
  }
}

function state(value: DomainRequest): DeploymentState {
  return { domainRequest: value } as DeploymentState
}

beforeEach(async () => {
  origins = [{ ...primary }]
  requestRow = {
    id: requestId,
    action: 'add',
    hostname: 'alias.example.com',
    tokenHash: await digest(token),
    status: 'pending',
    error: null,
    updatedAt: new Date().toISOString(),
  }
  vi.mocked(readL4Server).mockResolvedValue({
    origin: primary.origin,
    resources: { databaseId: 'database', bucketName: 'files', backupBucketName: 'backups' },
  } as never)
  vi.mocked(findAppDomainZone).mockResolvedValue({ id: 'zone', name: 'example.com', status: 'active' } as never)
  vi.mocked(connectAppDomain).mockResolvedValue({ id: 'domain', hostname: 'alias.example.com' } as never)
  vi.mocked(findAppDomain).mockResolvedValue({ id: 'domain', hostname: 'alias.example.com' } as never)
  vi.mocked(setPrimaryAppDomain).mockResolvedValue({ hostname: 'alias.example.com' } as never)
  vi.mocked(queryRows).mockImplementation(async (_token, _account, _database, sql, params = []) => {
    if (sql.includes('FROM server_domain_requests WHERE id = ?')) return [requestRow]
    if (sql.includes("SET status = 'running'") && sql.includes('RETURNING id')) return [{ id: requestId }]
    if (sql.startsWith('INSERT OR IGNORE INTO server_domains')) {
      const origin = String(params[0])
      if (!origins.some(item => item.origin === origin)) {
        origins.push({ origin, hostname: String(params[1]), primary: Number(params[2]) })
      }
      return []
    }
    if (sql.startsWith('SELECT origin, hostname')) return [...origins]
    if (sql.startsWith('UPDATE server_domains SET is_primary = 1 WHERE origin = ? AND NOT EXISTS')) {
      if (!origins.some(item => item.primary)) {
        origins = origins.map(item => ({ ...item, primary: item.origin === String(params[0]) ? 1 : 0 }))
      }
      return []
    }
    if (sql.startsWith('UPDATE server_domains SET is_primary = CASE WHEN origin = ?')) {
      origins = origins.map(item => ({ ...item, primary: item.origin === String(params[0]) ? 1 : 0 }))
      return []
    }
    if (sql.startsWith('DELETE FROM server_domains')) {
      origins = origins.filter(item => item.origin !== String(params[0]))
      return []
    }
    if (sql.startsWith('UPDATE server_domain_requests SET status = ?')) {
      requestRow = { ...requestRow, status: String(params[0]), error: params[1] ?? null }
      return []
    }
    throw new Error(`Unexpected query: ${sql}`)
  })
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('domain request state', () => {
  it('keeps the single-use token out of the public session payload', () => {
    const data = {} as DeploymentState
    rememberDomainRequest(data, {
      origin: 'https://primary.example.com/',
      accountId,
      workerName,
      requestId,
      token,
      action: 'add',
      hostname: 'Alias.Example.com',
    })
    expect(data.domainRequest?.origin).toBe(primary.origin)
    expect(data.domainRequest?.hostname).toBe('alias.example.com')
    expect(publicDomainRequest(data)).not.toHaveProperty('token')
  })

  it('rejects an invalid request before storing it', () => {
    expect(() => rememberDomainRequest({} as DeploymentState, {
      origin: 'not-an-origin',
      accountId,
      workerName,
      requestId,
      token,
      action: 'add',
      hostname: 'alias.example.com',
    })).toThrow()
  })
})

describe('applyDomainChange', () => {
  it('attaches an alias and records it without changing the primary', async () => {
    const result = await applyDomainChange(state(request()), token)
    expect(connectAppDomain).toHaveBeenCalledWith(
      token,
      accountId,
      workerName,
      expect.objectContaining({ id: 'zone' }),
      'alias.example.com',
    )
    expect(setPrimaryAppDomain).not.toHaveBeenCalled()
    expect(result.primary).toBe(false)
    expect(result.origins.map(item => item.origin)).toEqual([
      primary.origin,
      'https://alias.example.com',
    ])
    expect(requestRow.status).toBe('complete')
  })

  it('repairs a list with no primary before adding an alias', async () => {
    origins = [{ ...primary, primary: 0 }]
    const result = await applyDomainChange(state(request()), token)
    expect(result.origins.find(item => item.origin === primary.origin)?.primary).toBe(true)
    expect(result.origins.filter(item => item.primary)).toHaveLength(1)
  })

  it('attaches an alias and switches the primary in one request', async () => {
    const result = await applyDomainChange(state(request({ makePrimary: true })), token)
    expect(setPrimaryAppDomain).toHaveBeenCalledWith(token, accountId, workerName, expect.objectContaining({ id: 'zone' }), 'alias.example.com')
    expect(result.primary).toBe(true)
    expect(result.origins.find(item => item.origin === 'https://alias.example.com')?.primary).toBe(true)
  })

  it('removes an alias from Cloudflare and the database', async () => {
    origins.push({ origin: 'https://alias.example.com', hostname: 'alias.example.com', primary: 0 })
    requestRow = { ...requestRow, action: 'remove' }
    const result = await applyDomainChange(state(request({ action: 'remove' })), token)
    expect(disconnectAppDomain).toHaveBeenCalledWith(token, accountId, workerName, 'domain')
    expect(result.origins.map(item => item.origin)).toEqual([primary.origin])
  })

  it('promotes an attached alias to primary', async () => {
    origins.push({ origin: 'https://alias.example.com', hostname: 'alias.example.com', primary: 0 })
    requestRow = { ...requestRow, action: 'primary', hostname: 'alias.example.com' }
    const result = await applyDomainChange(state(request({ action: 'primary', hostname: 'alias.example.com' })), token)
    expect(findAppDomain).toHaveBeenCalledWith(token, accountId, workerName, 'alias.example.com')
    expect(setPrimaryAppDomain).toHaveBeenCalledWith(token, accountId, workerName, expect.objectContaining({ id: 'zone' }), 'alias.example.com')
    expect(result.primary).toBe(true)
    expect(result.origins.find(item => item.origin === 'https://alias.example.com')?.primary).toBe(true)
  })

  it('refuses to promote an address that is no longer attached in Cloudflare', async () => {
    origins.push({ origin: 'https://alias.example.com', hostname: 'alias.example.com', primary: 0 })
    requestRow = { ...requestRow, action: 'primary', hostname: 'alias.example.com' }
    vi.mocked(findAppDomain).mockResolvedValue(null)
    await expect(applyDomainChange(state(request({ action: 'primary', hostname: 'alias.example.com' })), token))
      .rejects.toThrow('not attached in Cloudflare')
    expect(setPrimaryAppDomain).not.toHaveBeenCalled()
  })

  it('refuses to remove the primary', async () => {
    requestRow = { ...requestRow, action: 'remove', hostname: 'primary.example.com' }
    await expect(applyDomainChange(state(request({ action: 'remove', hostname: 'primary.example.com' })), token))
      .rejects.toThrow('Choose another primary')
    expect(disconnectAppDomain).not.toHaveBeenCalled()
  })

  it('rejects a replayed token that does not match the Server row', async () => {
    requestRow = { ...requestRow, tokenHash: await digest('c'.repeat(64)) }
    await expect(applyDomainChange(state(request()), token)).rejects.toThrow('could not be verified')
    expect(connectAppDomain).not.toHaveBeenCalled()
  })

  it('surfaces a previous failure instead of running it again', async () => {
    requestRow = { ...requestRow, status: 'failed', error: 'Cloudflare refused the change' }
    await expect(applyDomainChange(state(request()), token)).rejects.toThrow('Cloudflare refused the change')
    expect(connectAppDomain).not.toHaveBeenCalled()
  })

  it('expires an unopened request instead of applying it later', async () => {
    requestRow = { ...requestRow, updatedAt: new Date(Date.now() - 21 * 60 * 1000).toISOString() }
    await expect(applyDomainChange(state(request()), token)).rejects.toThrow('expired')
    expect(connectAppDomain).not.toHaveBeenCalled()
    expect(requestRow.status).toBe('failed')
  })
})
