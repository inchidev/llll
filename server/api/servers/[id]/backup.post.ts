import { sha256 } from '@noble/hashes/sha2.js'
import { changeUpdateRecord } from '../../../../shared/server-updates'
import { updateStorage } from '../../../utils/server-updates'
import { serverVersion } from '../../../utils/version'
import { cf, requireFiles, fail, originOk } from '../../../utils/cf'
import { requireMember } from '../../../utils/guards'
import { writeAudit } from '../../../utils/messages'
import { createServerBackup } from '../../../utils/server-backup'

export default defineEventHandler(async (event) => {
  if (!await originOk(event)) fail(403, 'bad_origin', 'Invalid request origin')
  const serverId = getRouterParam(event, 'id')!
  const member = await requireMember(event, serverId)
  if (!member.isOwner) fail(403, 'forbidden', 'Only the owner can download backups')

  const { env } = cf(event)
  requireFiles(env)
  const createdAt = new Date().toISOString()
  const version = serverVersion(env)
  await writeAudit(env, {
    serverId,
    actorId: member.user.id,
    action: 'backup.download',
    targetType: 'server',
    targetId: serverId,
    meta: { format: 'llll-tar-v1', version },
  })

  const stamp = createdAt.replaceAll(':', '-').replace('.000Z', 'Z')
  setHeader(event, 'Content-Type', 'application/x-tar')
  setHeader(event, 'Content-Disposition', `attachment; filename="llll-backup-${stamp}.tar"`)
  setHeader(event, 'Cache-Control', 'no-store, max-age=0')
  setHeader(event, 'Cross-Origin-Resource-Policy', 'same-origin')
  setHeader(event, 'X-Content-Type-Options', 'nosniff')
  const updateId = getQuery(event).update
  if (typeof updateId !== 'string') return createServerBackup(env, createdAt, version)
  const store = updateStorage(env, serverId)
  const { value } = await store.read()
  if (env.BACKUPS || value.job?.id !== updateId || value.job.stage !== 'queued' || value.job.sourceVersion !== version) fail(409, 'backup_request', 'Start a new update request before downloading its backup')
  const hash = sha256.create()
  let sizeBytes = 0
  return createServerBackup(env, createdAt, version).pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) { hash.update(chunk); sizeBytes += chunk.byteLength; controller.enqueue(chunk) },
    async flush() {
      const digest = Array.from(hash.digest()).map(byte => byte.toString(16).padStart(2, '0')).join('')
      await changeUpdateRecord(store, record => {
        if (record.job?.id !== updateId || record.job.stage !== 'queued') throw new Error('The update request changed during backup')
        record.job.backup = { destination: 'download', key: `llll-backup-${stamp}.tar`, bucket: '', sizeBytes, sha256: digest, createdAt, verified: false }
      })
    },
  }))
})
