import { sha256 } from '@noble/hashes/sha2.js'
import { z } from 'zod'
import { verifyDeployment } from '../../../packages/deployment-core/src/deploy'
import { updateL4 } from '../../../packages/deployment-core/src/installer'
import { readL4Server } from '../../../packages/deployment-core/src/servers'
import { compareVersions } from '../../../shared/release-version'
import { createUpdateStore } from '../../../shared/server-update-store'
import { activeUpdate, changeUpdateRecord } from '../../../shared/server-updates'
import { cloudflare } from './deploy'
import { handOffCloudflareAccess } from './handoff'
import type {
  DeploymentState,
  UpdateBackupReceipt,
  UpdateState,
} from './session'

const ACCOUNT = /^[0-9a-f]{32}$/
const WORKER = /^[a-z0-9][a-z0-9-]{0,62}$/
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/
const RELEASE_REPO = 'inchidev/llll'
const STALE_MS = 20 * 60 * 1000
const stale = (job: { updatedAt: string }) => Date.now() - Date.parse(job.updatedAt) > STALE_MS

export const updateRequestSchema = z.object({
  origin: z.string().trim().max(2048),
  accountId: z.string().regex(ACCOUNT),
  workerName: z.string().regex(WORKER),
  jobId: z.string().uuid(),
})

type Identity = {
  product: 'llll'
  kind: 'server'
  id: string
  origin: string
  aliases?: string[]
  version: string
  ready?: boolean
}

function normalizeOrigin(value: string) {
  const url = new URL(value)
  if (
    url.protocol !== 'https:' ||
    url.pathname !== '/' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error('Enter the public HTTPS address of the Server you are updating')
  return url.origin
}

export async function rememberUpdate(state: DeploymentState, value: unknown) {
  const request = updateRequestSchema.parse(value)
  const origin = normalizeOrigin(request.origin)
  state.updateRequest = { ...request, origin }
  return state.updateRequest
}

export function publicUpdate(state: DeploymentState) {
  const update = state.update
  if (!update) return undefined
  return {
    origin: update.origin,
    accountId: update.accountId,
    workerName: update.workerName,
    jobId: update.jobId,
    installedVersion: update.installedVersion,
    targetVersion: update.targetVersion,
    phase: update.phase,
    done: update.phase === 'done',
    deploymentStarted: Boolean(update.deploymentStarted),
    accessKept: Boolean(update.accessKept),
    accessError: update.accessError,
    backup: update.backup
      ? {
          sizeBytes: update.backup.sizeBytes,
          verified: update.backup.verified,
          createdAt: update.backup.createdAt,
        }
      : null,
    error: update.error || null,
  }
}

async function identity(origin: string): Promise<Identity> {
  let response: Response
  try {
    response = await fetch(origin + '/.well-known/llll', {
      redirect: 'manual',
      signal: AbortSignal.timeout(15000),
    })
  } catch {
    throw new Error('The Server did not answer. Check that it is online, then retry.')
  }
  if (!response.ok) throw new Error(`The Server did not answer (HTTP ${response.status}).`)
  const data = (await response.json()) as Partial<Identity>
  const aliases = Array.isArray(data.aliases) ? data.aliases.filter((item): item is string => typeof item === 'string') : []
  if (
    data.product !== 'llll' ||
    data.kind !== 'server' ||
    !data.id ||
    !/^[0-9a-f-]{36}$/i.test(data.id) ||
    (data.origin !== origin && !aliases.includes(origin)) ||
    !data.version ||
    !VERSION.test(data.version)
  )
    throw new Error('The address does not identify the same L4 Server')
  return data as Identity
}

function updateStore(token: string, accountId: string, databaseId: string) {
  return createUpdateStore(async (sql, params) => {
    const result = await cloudflare<Array<{ success?: boolean; results?: unknown[] }>>(
      token,
      `/accounts/${accountId}/d1/database/${databaseId}/query`,
      'POST',
      { sql, params },
    )
    if (result.some((part) => part.success === false))
      throw new Error('The Server database query failed')
    return result.flatMap((part) => part.results || []) as {
      payload: string
      revision: number
    }[]
  })
}

export async function queryRows(
  token: string,
  accountId: string,
  databaseId: string,
  sql: string,
  params: (string | number | null)[] = [],
) {
  const result = await cloudflare<
    Array<{ success?: boolean; results?: unknown[] }>
  >(token, `/accounts/${accountId}/d1/database/${databaseId}/query`, 'POST', {
    sql,
    params,
  })
  if (result.some((part) => part.success === false))
    throw new Error('The Server database query failed')
  return result.flatMap((part) => part.results || []) as Record<string, unknown>[]
}

async function requireJob(store: ReturnType<typeof updateStore>, jobId: string) {
  const { value } = await store.read()
  const job = value.job
  if (!job || job.id !== jobId)
    throw new Error('This update request is no longer on the Server. Start a new one from Settings.')
  return { record: value, job }
}

/** Every persisted address, with the Worker's configured origin as a fallback. */
async function serverOrigins(
  token: string,
  accountId: string,
  databaseId: string,
  configuredOrigin: string,
) {
  const origins: string[] = []
  const add = (value: string) => {
    try {
      const origin = normalizeOrigin(value)
      if (!origins.includes(origin)) origins.push(origin)
    }
    catch { /* A malformed optional row must not hide a working address. */ }
  }
  add(configuredOrigin)
  try {
    const rows = await queryRows(token, accountId, databaseId, 'SELECT origin FROM server_domains ORDER BY is_primary DESC')
    for (const row of rows) add(String(row.origin || ''))
  }
  catch { /* Servers from before multi-origin releases have one address. */ }
  return origins
}

async function identifyAny(origins: string[]) {
  let lastError: unknown
  for (const origin of origins) {
    try {
      return { well: await identity(origin), origin }
    }
    catch (error) {
      lastError = error
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error('The Server did not answer at any of its connected addresses.')
}

/**
 * Site-side preparation for a Server update request. The owner authorizes this
 * browser session, so the Server itself never receives an account API token.
 */
export async function prepareUpdate(
  state: DeploymentState,
  value: unknown,
  token: string,
) {
  const request = await rememberUpdate(state, value)
  const server = await readL4Server(token, request.accountId, request.workerName)
  if (!server)
    throw new Error('The Server is not in the connected Cloudflare account')
  if (!server.resources.databaseId)
    throw new Error('The Server database is missing from Cloudflare')
  if (server.resources.backupBucketName && server.resources.backupBucketName === server.resources.bucketName)
    throw new Error('The update backup bucket must be separate from the Server files bucket')
  const origins = await serverOrigins(token, request.accountId, server.resources.databaseId, server.origin)
  if (!origins.includes(request.origin))
    throw new Error('The update address is not one of this Server’s connected addresses')
  const identified = await identifyAny([request.origin, ...origins.filter(origin => origin !== request.origin)])
  const well = identified.well
  const workingOrigin = identified.origin
  const store = updateStore(token, request.accountId, server.resources.databaseId)
  const { record, job } = await requireJob(store, request.jobId)
  if (job.serverId !== well.id)
    throw new Error('The update belongs to another Server')
  if (job.stage === 'complete') {
    state.update = {
      ...request,
      origin: workingOrigin,
      origins,
      serverId: well.id,
      databaseId: server.resources.databaseId,
      filesBucket: server.resources.bucketName || '',
      backupBucket: server.resources.backupBucketName || '',
      installedVersion: job.targetVersion,
      targetVersion: job.targetVersion,
      executorId: state.update?.executorId || crypto.randomUUID(),
      phase: 'done',
      backup: job.backup || undefined,
    }
    return state.update
  }
  if (!activeUpdate(job) && job.stage !== 'failed')
    throw new Error('This update request has ended. Start a new one from Settings.')
  const targetInstalled = well.version === job.targetVersion
  if (job.sourceVersion !== well.version && !targetInstalled)
    throw new Error(
      `The request was made for L4 ${job.sourceVersion}, but the Server now reports ${well.version}. Start a new update request on the Server.`,
    )
  if (
    !targetInstalled &&
    (!VERSION.test(job.targetVersion) ||
      compareVersions(job.targetVersion, well.version) <= 0)
  )
    throw new Error('The selected release is not newer than the installed version')
  if (
    job.buildId &&
    job.buildId !== state.update?.executorId &&
    ['backing_up', 'updating', 'verifying'].includes(job.stage) &&
    !(stale(job) && !record.backupBusy)
  )
    throw new Error('Another operator is already updating this Server')

  const previous = state.update?.jobId === job.id ? state.update : undefined
  const resumed: UpdateState['phase'] = targetInstalled
    ? 'verify'
    : job.stage === 'failed'
      ? job.backup
        ? job.backup.verified
          ? 'deploy'
          : 'backup'
        : 'release'
      : job.stage === 'verifying'
        ? 'verify'
        : job.stage === 'updating'
          ? 'deploy'
          : job.stage === 'backing_up'
            ? 'backup'
            : job.backup?.verified
              ? 'deploy'
              : 'release'
  state.update = {
    ...request,
    origin: workingOrigin,
    origins,
    serverId: well.id,
    databaseId: server.resources.databaseId,
    filesBucket: server.resources.bucketName || '',
    backupBucket: server.resources.backupBucketName || '',
    installedVersion: well.version,
    targetVersion: job.targetVersion,
    executorId: previous?.executorId || crypto.randomUUID(),
    phase: resumed,
    backup: job.backup || previous?.backup,
    deploymentStarted: previous?.deploymentStarted,
  }
  return state.update
}

export async function advanceUpdate(
  state: DeploymentState,
  token: string,
  save: () => Promise<void>,
) {
  const update = state.update
  if (!update) throw new Error('Start the update from your Server’s Settings.')
  if (update.phase === 'done') return
  const store = updateStore(token, update.accountId, update.databaseId)
  if (update.phase === 'release') {
    await verifyRelease(update.targetVersion)
    update.phase = 'backup'
    await save()
    return
  }
  if (update.phase === 'backup') {
    await createVerifiedBackup(update, token, store)
    update.phase = 'deploy'
    await save()
    return
  }
  if (update.phase === 'deploy') {
    await deployVerifiedRelease(update, token, store, save)
    update.phase = 'verify'
    await save()
    return
  }
  if (update.phase === 'verify') {
    if (await verifyUpdatedServer(update, store)) {
      update.phase = 'done'
      if (update.keepAccess) {
        try { await handOffCloudflareAccess(state, { accountId: update.accountId, origin: update.origin, workerName: update.workerName, databaseId: update.databaseId }); update.accessKept = true }
        catch (error) { update.accessError = error instanceof Error ? error.message : 'Cloudflare access was not kept on the Server' }
      }
    }
    await save()
  }
}

async function claim(store: ReturnType<typeof updateStore>, update: UpdateState) {
  await changeUpdateRecord(store, (record) => {
    const job = record.job
    if (!job || job.id !== update.jobId)
      throw new Error('This update request is no longer on the Server')
    if (
      job.stage === 'updating' ||
      job.stage === 'verifying' ||
      job.stage === 'complete'
    )
      return
    if (
      job.buildId &&
      job.buildId !== update.executorId &&
      ['backing_up', 'updating', 'verifying'].includes(job.stage) &&
      !(stale(job) && !record.backupBusy)
    )
      throw new Error('Another operator is already updating this Server')
    job.buildId = update.executorId
    job.stage = 'backing_up'
    job.updatedAt = new Date().toISOString()
    job.error = null
    record.backupBusy = false
  })
}

async function createVerifiedBackup(
  update: UpdateState,
  token: string,
  store: ReturnType<typeof updateStore>,
) {
  let { job } = await requireJob(store, update.jobId)
  if (
    job.stage === 'updating' ||
    job.stage === 'verifying' ||
    job.stage === 'complete'
  ) {
    if (!job.backup) throw new Error('The pre-update backup is missing')
    update.backup = job.backup
    return
  }
  if (!update.backupBucket) {
    if (!job.backup?.verified || job.backup.destination !== 'download') throw new Error('Download the pre-update backup from your Server before continuing.')
    update.backup = job.backup
    return
  }
  let backup = job.backup
  if (!backup) {
    await claim(store, update)
    const claimed = await requireJob(store, update.jobId)
    const record = claimed.record
    job = claimed.job
    if (job.buildId !== update.executorId)
      throw new Error('Another operator is already updating this Server')
    if (!record.backupToken)
      throw new Error('The update capability is missing. Start a new update request from Settings.')
    let response: Response
    try {
      response = await fetch(
        `${update.origin}/api/servers/${update.serverId}/updates/backup`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${record.backupToken}`,
          },
          body: JSON.stringify({
            requestId: update.jobId,
            buildId: update.executorId,
          }),
          signal: AbortSignal.timeout(45 * 60 * 1000),
        },
      )
    } catch {
      throw new Error(
        'The pre-update backup did not answer. The Worker has not been updated; retry when the Server is reachable.',
      )
    }
    const body = (await response.json().catch(() => null)) as
      | { backup?: UpdateBackupReceipt; error?: { message?: string } }
      | null
    if (!response.ok || !body?.backup)
      throw new Error(
        body?.error?.message ||
          'The pre-update backup did not complete. The Worker has not been updated.',
      )
    backup = body.backup
  }
  if (backup.bucket !== update.backupBucket)
    throw new Error('The pre-update backup is not in this Server’s backup bucket')
  if (!backup.key.startsWith(`servers/${update.serverId}/pre-update/${update.jobId}/`))
    throw new Error('The pre-update backup does not belong to this update request')
  try {
    await verifyBackupArchive(
      token,
      update.accountId,
      update.databaseId,
      update.filesBucket,
      backup,
    )
  } catch (error) {
    // A changed live Server or an incomplete archive needs a fresh backup on
    // retry; re-checking the same unverified object can never succeed.
    await changeUpdateRecord(store, (record) => {
      if (
        record.job?.id === update.jobId &&
        record.job.backup &&
        !record.job.backup.verified
      )
        record.job.backup = null
      record.backupBusy = false
    }).catch(() => {})
    throw error
  }
  await changeUpdateRecord(store, (record) => {
    if (record.job?.id !== update.jobId)
      throw new Error('This update request changed during backup verification')
    if (!record.job.backup) throw new Error('The pre-update backup is missing')
    record.job.backup = { ...record.job.backup, verified: true }
    record.job.updatedAt = new Date().toISOString()
    record.backupBusy = false
  })
  update.backup = { ...backup, verified: true }
}

async function deployVerifiedRelease(
  update: UpdateState,
  token: string,
  store: ReturnType<typeof updateStore>,
  save: () => Promise<void>,
) {
  const { job } = await requireJob(store, update.jobId)
  if (
    !job.backup?.verified &&
    !['updating', 'verifying', 'complete'].includes(job.stage)
  )
    throw new Error('The pre-update backup is not verified yet')
  const identified = await identifyAny(update.origins?.length ? update.origins : [update.origin])
  const well = identified.well
  update.origin = identified.origin
  if (well.id !== update.serverId)
    throw new Error('The Server identity changed; refusing to update')
  if (well.version === update.targetVersion) {
    await markStage(store, update, 'verifying')
    return
  }
  if (well.version !== update.installedVersion)
    throw new Error(
      `The Server now reports L4 ${well.version}. Start a new update request from Settings.`,
    )
  await markStage(store, update, 'updating')
  update.deploymentStarted = true
  await save()
  await updateL4(
    token,
    {
      accountId: update.accountId,
      workerName: update.workerName,
      targetVersion: update.targetVersion,
    },
    { verify: false },
  )
  await markStage(store, update, 'verifying')
}

async function markStage(
  store: ReturnType<typeof updateStore>,
  update: UpdateState,
  stage: 'updating' | 'verifying',
) {
  await changeUpdateRecord(store, (record) => {
    if (record.job?.id !== update.jobId)
      throw new Error('This update request changed during deployment')
    record.job.stage = stage
    record.job.error = null
    record.job.updatedAt = new Date().toISOString()
  })
}

async function verifyUpdatedServer(
  update: UpdateState,
  store: ReturnType<typeof updateStore>,
) {
  for (const origin of update.origins?.length ? update.origins : [update.origin]) {
    let well: Identity
    try {
      well = await identity(origin)
    }
    catch {
      continue
    }
    if (well.id !== update.serverId)
      throw new Error('The Server identity changed during the update')
    if (well.version !== update.targetVersion) continue
    try {
      await verifyDeployment(origin, update.targetVersion, true, undefined, {
        attempts: 1,
        delayMs: 0,
      })
    }
    catch {
      continue
    }
    update.origin = origin
    await changeUpdateRecord(store, (record) => {
      if (record.job?.id !== update.jobId) return
      record.job.stage = 'complete'
      record.job.error = null
      record.job.updatedAt = new Date().toISOString()
      if (record.job.backup) record.job.backup.verified = true
      record.backupToken = null
      record.backupBusy = false
    })
    return true
  }
  return false
}

export async function failUpdate(state: DeploymentState, token: string) {
  const update = state.update
  if (!update) return
  update.error ||= 'The update did not complete. Retry to resume.'
  try {
    const store = updateStore(token, update.accountId, update.databaseId)
    await changeUpdateRecord(store, (record) => {
      if (record.job?.id !== update.jobId) return
      record.job.stage = update.deploymentStarted ? 'attention' : 'failed'
      record.job.error = update.error || 'The update did not complete.'
      record.job.updatedAt = new Date().toISOString()
      record.backupBusy = false
    })
  } catch {
    /* The Server may be unreachable; its saved request stays visible. */
  }
}

export async function verifyRelease(version: string) {
  const target = version.replace(/^v/, '')
  if (!VERSION.test(target)) throw new Error('The selected release version is invalid')
  const tag = 'v' + target
  const base = `https://github.com/${RELEASE_REPO}/releases/download/${tag}`
  let sums: Response
  try {
    sums = await fetch(`${base}/SHA256SUMS`, { signal: AbortSignal.timeout(20000) })
  } catch {
    throw new Error(`L4 ${tag} could not be downloaded for verification`)
  }
  if (!sums.ok) throw new Error(`L4 ${tag} is not published`)
  const text = await sums.text()
  if (text.length > 65536) throw new Error('Release checksums are invalid')
  const expected = text.match(
    /^([a-f0-9]{64})[ \t]+llll-cloudflare-manifest\.json$/m,
  )?.[1]
  if (!expected) throw new Error('The release does not publish a Server manifest')
  const manifestResponse = await fetch(`${base}/llll-cloudflare-manifest.json`, {
    signal: AbortSignal.timeout(20000),
  })
  if (!manifestResponse.ok)
    throw new Error(`The L4 ${tag} manifest is unavailable`)
  const bytes = await manifestResponse.arrayBuffer()
  if (bytes.byteLength > 1024 * 1024)
    throw new Error('The release manifest is unexpectedly large')
  const hash = await crypto.subtle.digest('SHA-256', bytes)
  const actual = [...new Uint8Array(hash)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
  if (actual !== expected)
    throw new Error('The release manifest checksum did not match')
  const manifest = JSON.parse(new TextDecoder().decode(bytes)) as {
    version?: string
    capabilities?: string[]
  }
  if (
    manifest.version !== target ||
    !manifest.capabilities?.includes('llll-server-schema-v2')
  )
    throw new Error('The release cannot update this Server')
}

type BackupSummary = {
  tables: number
  databaseRows: number
  r2Objects: number
  r2Bytes: number
}
type BackupObject = { key: string; size: number; etag: string }

const objectPath = (accountId: string, bucket: string, key: string) =>
  `/accounts/${accountId}/r2/buckets/${encodeURIComponent(bucket)}/objects/${key
    .split('/')
    .map(encodeURIComponent)
    .join('/')}`

async function verifyBackupArchive(
  token: string,
  accountId: string,
  databaseId: string,
  filesBucket: string,
  receipt: UpdateBackupReceipt,
) {
  if (
    !/^[a-f0-9]{64}$/.test(receipt.sha256) ||
    !Number.isSafeInteger(receipt.sizeBytes) ||
    receipt.sizeBytes <= 0
  )
    throw new Error('The pre-update backup receipt is invalid')
  let response: Response
  try {
    response = await fetch('https://api.cloudflare.com/client/v4' + objectPath(accountId, receipt.bucket, receipt.key), {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10 * 60 * 1000),
    })
  } catch {
    throw new Error('The pre-update backup could not be reached in R2')
  }
  if (!response.ok || !response.body)
    throw new Error('The pre-update backup could not be read from R2')
  const reader = response.body.getReader()
  const hash = sha256.create()
  let total = 0
  let current = new Uint8Array(0)
  let offset = 0
  try {
    async function fill() {
      const { done, value } = await reader.read()
      if (done) return false
      total += value.byteLength
      hash.update(value)
      current = value
      offset = 0
      return true
    }
    async function read(length: number) {
      const out = new Uint8Array(length)
      let filled = 0
      while (filled < length) {
        if (offset === current.length && !(await fill()))
          throw new Error('The backup archive ended early')
        const count = Math.min(length - filled, current.length - offset)
        out.set(current.subarray(offset, offset + count), filled)
        offset += count
        filled += count
      }
      return out
    }
    async function skip(length: number) {
      let remaining = length
      while (remaining > 0) {
        if (offset === current.length && !(await fill()))
          throw new Error('The backup archive ended early')
        const count = Math.min(remaining, current.length - offset)
        offset += count
        remaining -= count
      }
    }
    async function drain() {
      // Consume the trailing zero blocks so the checksum covers the whole object.
      while (offset < current.length || (await fill())) offset = current.length
    }

    const decoder = new TextDecoder()
    let objectCount = 0
    let objectBytes = 0
    let pending: { sequence: string; size: number } | null = null
    let summary: BackupSummary | null = null
    let entries = 0
    while (true) {
      const header = await read(512)
      if (header.every((byte) => byte === 0)) {
        await drain()
        break
      }
      entries += 1
      if (entries > 2_000_000)
        throw new Error('The backup archive has too many entries')
      const name = decoder.decode(header.subarray(0, 100)).replace(/\0[\s\S]*$/, '')
      const size = Number.parseInt(
        decoder.decode(header.subarray(124, 136)).replace(/\0[\s\S]*$/, '').trim(),
        8,
      )
      const type = header[156]
      if (
        !name ||
        name.startsWith('/') ||
        name.split('/').includes('..') ||
        (type !== 0x30 && type !== 0)
      )
        throw new Error('The backup archive is malformed')
      if (!Number.isSafeInteger(size) || size < 0 || size > receipt.sizeBytes)
        throw new Error('The backup archive is malformed')
      let checksum = 0
      for (let index = 0; index < 512; index += 1)
        checksum += index >= 148 && index < 156 ? 0x20 : header[index]!
      const stored = Number.parseInt(
        decoder.decode(header.subarray(148, 156)).replace(/\0[\s\S]*$/, '').trim(),
        8,
      )
      if (stored !== checksum) throw new Error('The backup archive is malformed')
      if (name === 'summary.json' || /^r2\/\d{8}\.json$/.test(name)) {
        if (size > 1024 * 1024) throw new Error('The backup archive is malformed')
        const value = JSON.parse(decoder.decode(await read(size)))
        if (name === 'summary.json') summary = value as BackupSummary
        else {
          const sequence = name.slice(3, 11)
          const meta = value as BackupObject
          if (
            !meta ||
            typeof meta.key !== 'string' ||
            !Number.isSafeInteger(meta.size) ||
            meta.size < 0 ||
            typeof meta.etag !== 'string' ||
            pending ||
            sequence !== String(objectCount + 1).padStart(8, '0')
          )
            throw new Error('The backup archive is malformed')
          objectCount += 1
          objectBytes += meta.size
          pending = { sequence, size: meta.size }
        }
      } else {
        const binary = /^r2\/(\d{8})\.bin$/.exec(name)
        if (binary) {
          if (!pending || pending.sequence !== binary[1] || pending.size !== size)
            throw new Error('The backup archive is malformed')
          pending = null
        }
        await skip(size)
      }
      await skip((512 - (size % 512)) % 512)
    }
    if (!summary || total !== receipt.sizeBytes)
      throw new Error('The pre-update backup is incomplete')
    const digest = [...hash.digest()]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('')
    if (digest !== receipt.sha256)
      throw new Error('The pre-update backup checksum did not match')
    if (
      pending ||
      objectCount !== summary.r2Objects ||
      objectBytes !== summary.r2Bytes
    )
      throw new Error('The pre-update backup inventory is inconsistent')

    const tables = await queryRows(token, accountId, databaseId, 'PRAGMA table_list')
    let rows = 0
    let tableCount = 0
    for (const table of tables) {
      const name = String(table.name || '')
      const type = String(table.type || '')
      if (
        !name ||
        !['table', 'virtual'].includes(type) ||
        /^(?:sqlite_|_cf_)/.test(name)
      )
        continue
      tableCount += 1
      const count = await queryRows(
        token,
        accountId,
        databaseId,
        `SELECT COUNT(*) AS count FROM "${name.replaceAll('"', '""')}"`,
      )
      rows += Number(count[0]?.count || 0)
    }
    if (tableCount !== summary.tables || rows !== summary.databaseRows)
      throw new Error(
        'Server data changed while the backup was made. Keep activity low and start the update again.',
      )
    const files = await r2Inventory(token, accountId, filesBucket)
    if (files.objects !== summary.r2Objects || files.bytes !== summary.r2Bytes)
      throw new Error(
        'Server files changed while the backup was made. Keep activity low and start the update again.',
      )
  } catch (error) {
    await reader.cancel().catch(() => {})
    throw error
  } finally {
    reader.releaseLock()
  }
}

async function r2Inventory(token: string, accountId: string, bucket: string) {
  let cursor: string | undefined
  let objects = 0
  let bytes = 0
  do {
    const query = new URLSearchParams({ per_page: '1000' })
    if (cursor) query.set('cursor', cursor)
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets/${encodeURIComponent(bucket)}/objects?${query}`,
      {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(30000),
      },
    )
    const body = (await response.json().catch(() => null)) as {
      success?: boolean
      result?: Array<{ size?: number }>
      result_info?: { is_truncated?: boolean; cursor?: string }
      errors?: Array<{ message?: string }>
    } | null
    if (!response.ok || !body?.success)
      throw new Error(
        body?.errors?.[0]?.message || 'The Server files could not be listed',
      )
    for (const object of body.result || []) {
      objects += 1
      bytes += Number(object.size || 0)
    }
    cursor = body.result_info?.is_truncated ? body.result_info.cursor : undefined
  } while (cursor)
  return { objects, bytes }
}
