import { uploadBackupToR2 } from '../../../../shared/r2-backup'
import { version as packageVersion } from '../../../../package.json'
import { eq } from 'drizzle-orm'
import { backupDestinations } from '../../../../drizzle/schema'
import type { BucketBackupResultDTO } from '../../../../shared/backups'
import { authSecret } from '../../../utils/auth-config'
import { backupDestinationConfigured, loadBackupDestination } from '../../../utils/backup-destination'
import { cf, requireFiles, fail } from '../../../utils/cf'
import { getDb } from '../../../utils/db'
import { requireMember } from '../../../utils/guards'
import { writeAudit } from '../../../utils/messages'
import { backupObjectKey, uploadBackupToS3 } from '../../../utils/s3-backup'
import { createServerBackup } from '../../../utils/server-backup'

export default defineEventHandler(async (event): Promise<BucketBackupResultDTO> => {
  const serverId = getRouterParam(event, 'id')!
  const member = await requireMember(event, serverId)
  if (!member.isOwner) fail(403, 'forbidden', 'Only the owner can create backups')
  const { env } = cf(event)
  requireFiles(env)
  const config = await loadBackupDestination(env, authSecret(env, getRequestURL(event).origin))
  if (!backupDestinationConfigured(config)) {
    fail(409, 'backup_destination_unconfigured', config.secretReadable
      ? 'Configure an S3 backup destination first'
      : 'Saved S3 credentials cannot be decrypted; replace the Secret Access Key')
  }

  const createdAt = new Date().toISOString()
  const version = env.LLLL_VERSION?.trim() || packageVersion
  const key = backupObjectKey(config.prefix, createdAt, version)
  let uploaded: { sizeBytes: number }
  try {
    uploaded = config.bucketBinding
      ? await uploadBackupToR2(config.bucketBinding, key, createServerBackup(env, createdAt, version))
      : await uploadBackupToS3(config, key, createServerBackup(env, createdAt, version))
  }
  catch (error) {
    const message = error instanceof Error ? error.message : 'Backup upload failed'
    fail(502, 'backup_upload_failed', message)
  }

  await getDb(env.DB).update(backupDestinations).set({
    lastBackupKey: key,
    lastBackupAt: createdAt,
    lastBackupSizeBytes: uploaded.sizeBytes,
    updatedAt: createdAt,
  }).where(eq(backupDestinations.id, 1))
  await writeAudit(env, {
    serverId,
    actorId: member.user.id,
    action: 'backup.bucket.create',
    targetType: 'server',
    targetId: serverId,
    meta: { key, sizeBytes: uploaded.sizeBytes, format: 'llll-tar-v1', version },
  })
  return { key, sizeBytes: uploaded.sizeBytes, createdAt }
})
