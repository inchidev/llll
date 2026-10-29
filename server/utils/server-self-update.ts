import { sha256 } from '@noble/hashes/sha2.js'
import { updateL4 } from '../../packages/deployment-core/src/installer'
import { verifyPublishedRelease } from '../../packages/deployment-core/src/release'
import { uploadBackupToR2 } from '../../shared/r2-backup'
import { getServerId } from '../../shared/server-id'
import { SERVER_BACKUP_BUCKET, readServerSetting } from '../../shared/server-settings'
import { changeUpdateRecord, type ServerUpdateJob } from '../../shared/server-updates'
import type { L4Env } from '../../workers/env'
import { cloudflareAccessToken } from './cloudflare-account-access'
import { ensureMigrated } from './db'
import { createServerBackup } from './server-backup'
import { serverDeployment, updateStorage } from './server-updates'
import { serverVersion } from './version'

/**
 * An update this Server runs itself with the Cloudflare access its Owner kept
 * here. It advances in Durable Object alarms, so no browser tab has to stay
 * open, and each stage is recorded before it starts. Uploading replaces this
 * code, so the new version finishes the job: it confirms its own version and
 * migrations instead of fetching its public origin.
 */
export const SELF_EXECUTOR = 'server-'
export const isSelfRun = (job: ServerUpdateJob | null | undefined) => Boolean(job?.buildId?.startsWith(SELF_EXECUTOR))
export const updateRunnerName = (serverId: string) => `update:${serverId}`
const hex = (bytes: Uint8Array) => [...bytes].map(b => b.toString(16).padStart(2, '0')).join('')
const message = (error: unknown) => (error as { data?: { error?: { message?: string } } })?.data?.error?.message || (error instanceof Error ? error.message : '') || 'The update step failed'

type Attempts = { get(key: string): Promise<number | undefined>; put(key: string, value: number): Promise<void> }
type Runner = { attempts: Attempts; watchdog(ms: number): Promise<void> }

async function setStage(env: L4Env, jobId: string, change: (job: ServerUpdateJob) => void) {
  const store = updateStorage(env, await getServerId(env.DB))
  return changeUpdateRecord(store, record => {
    if (record.job?.id !== jobId || !isSelfRun(record.job)) throw new Error('Update request changed')
    change(record.job)
    record.job.updatedAt = new Date().toISOString()
    if (['complete', 'failed', 'cancelled'].includes(record.job.stage)) { record.backupToken = null; record.backupBusy = false }
  })
}

/** Backs up into the separate BACKUPS bucket and confirms the persisted object, not the stream. */
async function backUp(env: L4Env, job: ServerUpdateJob) {
  if (!env.BACKUPS) throw new Error('Updating from this Server needs its separate backup bucket. Use the official installer to download a backup instead.')
  const createdAt = new Date().toISOString(), serverId = await getServerId(env.DB)
  const key = `servers/${serverId}/pre-update/${job.id}/${createdAt.replaceAll(':', '-')}.tar`
  const hash = sha256.create()
  const stream = createServerBackup(env, createdAt, job.sourceVersion).pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ transform(chunk, controller) { hash.update(chunk); controller.enqueue(chunk) } }))
  const uploaded = await uploadBackupToR2(env.BACKUPS, key, stream)
  const digest = hex(hash.digest())
  const stored = await env.BACKUPS.get(key)
  if (!stored || stored.size !== uploaded.sizeBytes) throw new Error('The saved backup could not be read back')
  const check = sha256.create()
  const reader = stored.body.getReader()
  for (;;) { const next = await reader.read(); if (next.done) break; check.update(next.value) }
  if (hex(check.digest()) !== digest) throw new Error('The saved backup does not match what was written')
  const bucket = await readServerSetting(env.DB, SERVER_BACKUP_BUCKET) || env.BACKUP_BUCKET_NAME || ''
  return { destination: 'bucket' as const, key, bucket, sizeBytes: uploaded.sizeBytes, sha256: digest, createdAt, verified: true }
}

/** One step of a self-run update. Returns the delay before the next step, or null when settled. */
export async function advanceSelfUpdate(env: L4Env, runner: Runner): Promise<number | null> {
  const { value } = await updateStorage(env, await getServerId(env.DB)).read()
  const job = value.job
  if (!job || !isSelfRun(job) || !['backing_up', 'updating', 'verifying'].includes(job.stage)) return null
  try {
    if (job.stage === 'backing_up') {
      await verifyPublishedRelease(job.targetVersion)
      const backup = job.backup?.verified ? job.backup : await backUp(env, job)
      await setStage(env, job.id, current => { current.backup = backup; current.stage = 'updating'; current.error = null })
      return 0
    }
    if (job.stage === 'updating') {
      if (serverVersion(env) === job.targetVersion) { await setStage(env, job.id, current => { current.stage = 'verifying' }); return 0 }
      const attempt = (await runner.attempts.get(`upload:${job.id}`) ?? 0) + 1
      if (attempt > 3) throw new Error('The new release could not be uploaded after three attempts')
      await runner.attempts.put(`upload:${job.id}`, attempt)
      // The upload replaces this Worker; a later alarm resumes even if this one is cut short.
      await runner.watchdog(180_000)
      const deployment = await serverDeployment(env)
      if (!deployment) throw new Error('This Server no longer reports its Cloudflare account')
      const { token, accountId } = await cloudflareAccessToken(env)
      await updateL4(token, { accountId, workerName: deployment.workerName, targetVersion: job.targetVersion }, { verify: false })
      await setStage(env, job.id, current => { current.stage = 'verifying' })
      return 15_000
    }
    if (serverVersion(env) === job.targetVersion) {
      await ensureMigrated(env.DB, env)
      await setStage(env, job.id, current => { current.stage = 'complete'; current.error = null })
      return null
    }
    const checks = (await runner.attempts.get(`verify:${job.id}`) ?? 0) + 1
    await runner.attempts.put(`verify:${job.id}`, checks)
    if (checks > 40) throw new Error('The new version did not start within ten minutes')
    return 15_000
  } catch (error) {
    // Before the upload nothing changed; after it starts the Worker needs checking.
    const before = job.stage === 'backing_up'
    await setStage(env, job.id, current => { current.stage = before ? 'failed' : 'attention'; current.error = message(error) }).catch(() => undefined)
    return null
  }
}
