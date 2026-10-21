import { sha256 } from '@noble/hashes/sha2.js'
import { z } from 'zod'
import { changeUpdateRecord } from '../../../../../shared/server-updates'
import { getServerId } from '../../../../../shared/server-id'
import { uploadBackupToR2 } from '../../../../../shared/r2-backup'
import { cf, fail } from '../../../../utils/cf'
import { createServerBackup } from '../../../../utils/server-backup'
import { updateStorage } from '../../../../utils/server-updates'
import { parseBody } from '../../../../utils/validate'

/** Build-only, one-job capability: creates an archive but never returns its contents. */
export default defineEventHandler(async (event) => {
  setHeader(event, 'Cache-Control', 'no-store')
  const { env } = cf(event)
  const serverId = getRouterParam(event, 'id')!
  if (serverId !== await getServerId(env.DB)) fail(404, 'not_found', 'Server not found')
  const body = parseBody(z.object({ requestId: z.string().uuid(), buildId: z.string().uuid() }), await readBody(event))
  const store = updateStorage(env, serverId)
  const token = getHeader(event, 'authorization')?.replace(/^Bearer /, '') || ''
  if (!/^[a-f0-9]{64}$/.test(token)) fail(403, 'invalid_update_capability', 'Invalid update capability')
  const { value } = await store.read()
  const expected = value.backupToken
  const a = sha256(new TextEncoder().encode(token)), b = sha256(new TextEncoder().encode(expected || ''))
  let mismatch = 0
  for (let i = 0; i < a.length; i++) mismatch |= a[i]! ^ b[i]!
  if (!expected || mismatch || value.job?.id !== body.requestId || value.job.buildId !== body.buildId || value.job.stage !== 'backing_up') fail(403, 'invalid_update_capability', 'Invalid update capability')
  await changeUpdateRecord(store, record => {
    if (record.job?.id !== body.requestId || record.job.buildId !== body.buildId || record.job.stage !== 'backing_up' || record.backupBusy || record.job.backup) fail(409, 'backup_in_progress', 'This update backup has already started')
    record.backupBusy = true
  })
  const createdAt = new Date().toISOString()
  const key = `servers/${serverId}/pre-update/${body.requestId}/${createdAt.replaceAll(':', '-')}.tar`
  const hash = sha256.create()
  const stream = createServerBackup(env, createdAt, value.job.sourceVersion).pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ transform(chunk, controller) { hash.update(chunk); controller.enqueue(chunk) } }))
  try {
    const uploaded = await uploadBackupToR2(env.BACKUPS!, key, stream)
    const backup = { key, bucket: env.BACKUP_BUCKET_NAME!, sizeBytes: uploaded.sizeBytes, sha256: [...hash.digest()].map(b => b.toString(16).padStart(2, '0')).join(''), createdAt, verified: false }
    await changeUpdateRecord(store, record => {
      if (record.job?.id !== body.requestId || record.job.buildId !== body.buildId || record.job.stage !== 'backing_up') throw new Error('Update request changed during backup')
      record.job.backup = backup
      record.job.updatedAt = new Date().toISOString()
      record.backupBusy = false
    })
    return { backup }
  } catch {
    fail(502, 'update_backup_failed', 'The pre-update backup did not complete. The Worker has not been updated.')
  }
})
