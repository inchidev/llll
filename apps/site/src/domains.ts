import { z } from 'zod'
import {
  connectAppDomain,
  disconnectAppDomain,
  findAppDomain,
  findAppDomainZone,
  setPrimaryAppDomain,
} from '../../../packages/deployment-core/src/domains'
import { readL4Server } from '../../../packages/deployment-core/src/servers'
import { normalizeHostname, normalizeServerOrigin } from '../../../shared/server-origins'
import type { DeploymentState, DomainRequest } from './session'
import { digest } from './session'
import { queryRows } from './update'

const ACCOUNT = /^[0-9a-f]{32}$/
const WORKER = /^[a-z0-9][a-z0-9-]{0,62}$/
const STALE_MS = 20 * 60 * 1000

export const domainRequestSchema = z.object({
  origin: z.string().trim().max(2048),
  accountId: z.string().regex(ACCOUNT),
  workerName: z.string().regex(WORKER),
  requestId: z.string().uuid(),
  token: z.string().min(32).max(256),
  action: z.enum(['add', 'remove', 'primary']),
  hostname: z.string().trim().min(1).max(253),
  makePrimary: z.boolean().optional(),
  serverId: z.string().uuid().optional(),
})

type RequestRow = {
  id: string
  action: 'add' | 'remove' | 'primary'
  hostname: string
  tokenHash: string
  status: 'pending' | 'running' | 'complete' | 'failed'
  error: string | null
  updatedAt: string
}

type OriginRow = {
  origin: string
  hostname: string
  primary: number
}

export type DomainResult = {
  action: 'add' | 'remove' | 'primary'
  hostname: string
  origin: string
  primary: boolean
  origins: Array<{ origin: string, hostname: string, primary: boolean }>
}

export function rememberDomainRequest(state: DeploymentState, value: unknown): DomainRequest {
  const parsed = domainRequestSchema.parse(value)
  const request: DomainRequest = {
    ...parsed,
    origin: normalizeServerOrigin(parsed.origin),
    hostname: normalizeHostname(parsed.hostname),
  }
  state.domainRequest = request
  return request
}

export function publicDomainRequest(state: DeploymentState) {
  const request = state.domainRequest
  if (!request) return undefined
  return {
    origin: request.origin,
    accountId: request.accountId,
    workerName: request.workerName,
    requestId: request.requestId,
    action: request.action,
    hostname: request.hostname,
    makePrimary: request.makePrimary === true,
    serverId: request.serverId,
  }
}

async function origins(token: string, accountId: string, databaseId: string) {
  const rows = await queryRows(
    token,
    accountId,
    databaseId,
    'SELECT origin, hostname, is_primary AS primary FROM server_domains ORDER BY is_primary DESC, created_at ASC',
  ) as unknown as OriginRow[]
  return rows.map(row => ({
    origin: String(row.origin),
    hostname: String(row.hostname),
    primary: Number(row.primary) === 1,
  }))
}

async function mark(
  token: string,
  accountId: string,
  databaseId: string,
  id: string,
  status: 'complete' | 'failed',
  error: string | null,
) {
  await queryRows(
    token,
    accountId,
    databaseId,
    'UPDATE server_domain_requests SET status = ?, error = ?, updated_at = ? WHERE id = ?',
    [status, error, new Date().toISOString(), id],
  )
}

async function result(
  token: string,
  accountId: string,
  databaseId: string,
  request: DomainRequest,
): Promise<DomainResult> {
  const list = await origins(token, accountId, databaseId)
  const origin = `https://${request.hostname}`
  return {
    action: request.action,
    hostname: request.hostname,
    origin,
    primary: list.find(item => item.origin === origin)?.primary === true,
    origins: list,
  }
}

/**
 * Execute one domain change from the owner's browser. The Server stores only a
 * hash of the single-use token; Cloudflare credentials stay in this session.
 */
export async function applyDomainChange(state: DeploymentState, token: string): Promise<DomainResult> {
  const request = state.domainRequest
  if (!request) throw new Error('Open this page from your Server’s Settings')
  const server = await readL4Server(token, request.accountId, request.workerName)
  if (!server) throw new Error('The Server is not in the connected Cloudflare account')
  const databaseId = server.resources.databaseId
  if (!databaseId) throw new Error('The Server database is missing from Cloudflare')
  const serverOrigin = normalizeServerOrigin(server.origin || request.origin)
  const serverHostname = new URL(serverOrigin).hostname

  let row: RequestRow | undefined
  try {
    row = (await queryRows(
      token,
      request.accountId,
      databaseId,
      `SELECT id, action, hostname, token_hash AS tokenHash, status, error, updated_at AS updatedAt
       FROM server_domain_requests WHERE id = ?`,
      [request.requestId],
    ) as unknown as RequestRow[])[0]
  }
  catch {
    throw new Error('Update this Server to a release with address management before changing its domain')
  }
  if (!row) throw new Error('This domain request is no longer on the Server. Start a new one from Settings.')
  if (row.action !== request.action || row.hostname !== request.hostname)
    throw new Error('The domain request does not match this page')
  if (row.tokenHash !== await digest(request.token))
    throw new Error('This domain request could not be verified. Start a new one from Settings.')
  if (row.status === 'complete') return await result(token, request.accountId, databaseId, request)
  if (row.status === 'failed') throw new Error(row.error || 'The previous domain request did not complete. Start a new one from Settings.')
  if (row.status === 'pending' && Date.now() - Date.parse(row.updatedAt) > STALE_MS) {
    await mark(token, request.accountId, databaseId, request.requestId, 'failed', 'The domain request expired before it was applied. Start a new one from Settings.')
    throw new Error('This domain request expired. Start a new one from Settings.')
  }

  const now = Date.now()
  const stale = new Date(now - STALE_MS).toISOString()
  const claim = await queryRows(
    token,
    request.accountId,
    databaseId,
    `UPDATE server_domain_requests SET status = 'running', error = NULL, updated_at = ?
     WHERE id = ? AND (status = 'pending' OR (status = 'running' AND updated_at < ?)) RETURNING id`,
    [new Date(now).toISOString(), request.requestId, stale],
  )
  if (!claim.length) {
    const current = (await queryRows(
      token,
      request.accountId,
      databaseId,
      'SELECT status, error FROM server_domain_requests WHERE id = ?',
      [request.requestId],
    ) as unknown as Array<{ status: string, error: string | null }>)[0]
    if (current?.status === 'complete') return await result(token, request.accountId, databaseId, request)
    throw new Error(current?.error || 'The domain change is already running. Wait a moment, then check Settings.')
  }

  try {
    // Seed the configured primary before comparing the address list. The
    // conditional update repairs a list whose previous primary write stopped
    // halfway without ever creating a second primary.
    await queryRows(
      token,
      request.accountId,
      databaseId,
      'INSERT OR IGNORE INTO server_domains(origin, hostname, is_primary, created_at) VALUES (?, ?, 0, ?)',
      [serverOrigin, serverHostname, new Date(now).toISOString()],
    )
    await queryRows(
      token,
      request.accountId,
      databaseId,
      'UPDATE server_domains SET is_primary = 1 WHERE origin = ? AND NOT EXISTS (SELECT 1 FROM server_domains WHERE is_primary = 1)',
      [serverOrigin],
    )
    const known = new Set([serverOrigin, ...(await origins(token, request.accountId, databaseId)).map(item => item.origin)])
    if (!known.has(request.origin))
      throw new Error('This address is not connected to the Server. Open the request from its current address.')

    if (request.action === 'add') {
      const list = await origins(token, request.accountId, databaseId)
      const existing = list.find(item => item.hostname === request.hostname)
      if (existing) throw new Error('This address is already connected')
      const zone = await findAppDomainZone(token, request.accountId, request.hostname)
      await connectAppDomain(token, request.accountId, request.workerName, zone, request.hostname)
      const origin = `https://${request.hostname}`
      await queryRows(
        token,
        request.accountId,
        databaseId,
        'INSERT OR IGNORE INTO server_domains(origin, hostname, is_primary, created_at) VALUES (?, ?, 0, ?)',
        [origin, request.hostname, new Date().toISOString()],
      )
      if (request.makePrimary) {
        await setPrimaryAppDomain(token, request.accountId, request.workerName, zone, request.hostname)
        await queryRows(
          token,
          request.accountId,
          databaseId,
          'UPDATE server_domains SET is_primary = CASE WHEN origin = ? THEN 1 ELSE 0 END',
          [origin],
        )
      }
    }
    else if (request.action === 'remove') {
      const list = await origins(token, request.accountId, databaseId)
      const existing = list.find(item => item.hostname === request.hostname)
      if (!existing) throw new Error('This address is not connected')
      if (existing.primary) throw new Error('Choose another primary address before removing this one')
      const attached = await findAppDomain(token, request.accountId, request.workerName, request.hostname)
      if (attached) await disconnectAppDomain(token, request.accountId, request.workerName, attached.id)
      await queryRows(
        token,
        request.accountId,
        databaseId,
        'DELETE FROM server_domains WHERE origin = ? AND is_primary = 0',
        [existing.origin],
      )
    }
    else {
      const list = await origins(token, request.accountId, databaseId)
      const existing = list.find(item => item.hostname === request.hostname)
      if (!existing) throw new Error('This address is not connected')
      if (existing.primary) throw new Error('This is already the primary address')
      const attached = await findAppDomain(token, request.accountId, request.workerName, request.hostname)
      if (!attached) throw new Error('This address is not attached in Cloudflare. Remove it, then add it again.')
      const zone = await findAppDomainZone(token, request.accountId, request.hostname)
      await setPrimaryAppDomain(token, request.accountId, request.workerName, zone, request.hostname)
      await queryRows(
        token,
        request.accountId,
        databaseId,
        'UPDATE server_domains SET is_primary = CASE WHEN origin = ? THEN 1 ELSE 0 END',
        [existing.origin],
      )
    }

    await mark(token, request.accountId, databaseId, request.requestId, 'complete', null)
    return await result(token, request.accountId, databaseId, request)
  }
  catch (error) {
    const message = error instanceof Error ? error.message : 'The domain change did not complete.'
    try { await mark(token, request.accountId, databaseId, request.requestId, 'failed', message) }
    catch { /* The original error is more useful. */ }
    throw error
  }
}
