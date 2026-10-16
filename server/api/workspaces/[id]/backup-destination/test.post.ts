import type { BackupDestinationRuntimeConfig } from '../../../../utils/backup-destination'
import { authSecret } from '../../../../utils/auth-config'
import {
  backupDestinationSchema,
  loadBackupDestination,
  normalizeBackupEndpoint,
  normalizeBackupPrefix,
} from '../../../../utils/backup-destination'
import { cf, fail } from '../../../../utils/cf'
import { requireMember } from '../../../../utils/guards'
import { writeAudit } from '../../../../utils/messages'
import { testS3Destination } from '../../../../utils/s3-backup'
import { parseBody } from '../../../../utils/validate'

export default defineEventHandler(async (event): Promise<{ ok: true }> => {
  const workspaceId = getRouterParam(event, 'id')!
  const member = await requireMember(event, workspaceId)
  if (!member.isOwner) fail(403, 'forbidden', 'Only the owner can test backup destinations')
  const body = parseBody(backupDestinationSchema, await readBody(event))
  const { env } = cf(event)
  const saved = await loadBackupDestination(env, authSecret(env, getRequestURL(event).origin))
  const secretAccessKey = body.secretAccessKey?.trim() || saved.secretAccessKey
  if (!secretAccessKey) fail(400, 'secret_access_key_required', 'Secret Access Key is required')
  const config: BackupDestinationRuntimeConfig = {
    endpoint: normalizeBackupEndpoint(body.endpoint),
    region: body.region,
    bucket: body.bucket,
    prefix: normalizeBackupPrefix(body.prefix),
    accessKeyId: body.accessKeyId,
    secretAccessKey,
    secretConfigured: true,
    secretReadable: true,
    lastBackupKey: null,
    lastBackupAt: null,
    lastBackupSizeBytes: null,
    updatedAt: null,
  }
  try {
    await testS3Destination(config)
  }
  catch (error) {
    const message = error instanceof Error ? error.message : 'S3 connection test failed'
    fail(502, 's3_connection_failed', message)
  }
  await writeAudit(env, {
    workspaceId,
    actorId: member.user.id,
    action: 'backup.destination.test',
    targetType: 'workspace',
    targetId: workspaceId,
    meta: { endpoint: new URL(config.endpoint).host, bucket: config.bucket, prefix: config.prefix },
  })
  return { ok: true }
})
