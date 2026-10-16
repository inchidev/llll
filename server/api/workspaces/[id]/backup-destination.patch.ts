import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { backupDestinations } from '../../../../drizzle/schema'
import type { BackupDestinationDTO } from '../../../../shared/backups'
import { encryptSecret } from '../../../../shared/encrypted-secret'
import { nowIso, WORKSPACE_ID } from '../../../../shared/ids'
import { authSecret } from '../../../utils/auth-config'
import {
  BACKUP_S3_SECRET_SCOPE,
  backupDestinationDto,
  backupDestinationSchema,
  loadBackupDestination,
  normalizeBackupEndpoint,
  normalizeBackupPrefix,
} from '../../../utils/backup-destination'
import { cf, fail } from '../../../utils/cf'
import { getDb } from '../../../utils/db'
import { requireMember } from '../../../utils/guards'
import { writeAudit } from '../../../utils/messages'
import { parseBody } from '../../../utils/validate'

const bodySchema = z.union([
  z.object({ remove: z.literal(true) }),
  backupDestinationSchema.extend({ remove: z.literal(false).optional() }),
])

export default defineEventHandler(async (event): Promise<{ destination: BackupDestinationDTO }> => {
  const workspaceId = getRouterParam(event, 'id')!
  const member = await requireMember(event, workspaceId)
  if (!member.isOwner) fail(403, 'forbidden', 'Only the owner can manage backup destinations')
  const body = parseBody(bodySchema, await readBody(event))
  const { env } = cf(event)
  const installationSecret = authSecret(env, getRequestURL(event).origin)
  const db = getDb(env.DB)

  if (body.remove) {
    await db.delete(backupDestinations).where(eq(backupDestinations.id, 'main'))
    await writeAudit(env, {
      workspaceId: WORKSPACE_ID,
      actorId: member.user.id,
      action: 'backup.destination.remove',
      targetType: 'workspace',
      targetId: WORKSPACE_ID,
    })
    return { destination: backupDestinationDto(await loadBackupDestination(env, installationSecret)) }
  }

  const current = await loadBackupDestination(env, installationSecret)
  const stored = (await db.select().from(backupDestinations).where(eq(backupDestinations.id, 'main')).limit(1))[0]
  const plainSecret = body.secretAccessKey?.trim() || ''
  if (!plainSecret && !current.secretConfigured) fail(400, 'secret_access_key_required', 'Secret Access Key is required')
  if (!plainSecret && !current.secretReadable) fail(400, 'secret_access_key_required', 'Replace the Secret Access Key after changing AUTH_SECRET')
  const encrypted = plainSecret
    ? await encryptSecret(installationSecret, BACKUP_S3_SECRET_SCOPE, plainSecret)
    : null
  const endpoint = normalizeBackupEndpoint(body.endpoint)
  const prefix = normalizeBackupPrefix(body.prefix)
  const changedLocation = Boolean(current.endpoint) && (
    current.endpoint !== endpoint
    || current.bucket !== body.bucket
    || current.prefix !== prefix
  )
  const timestamp = nowIso()
  await db.insert(backupDestinations).values({
    id: 'main',
    endpoint,
    region: body.region,
    bucket: body.bucket,
    prefix,
    accessKeyId: body.accessKeyId,
    secretAccessKeyCiphertext: encrypted?.ciphertext ?? stored!.secretAccessKeyCiphertext,
    secretAccessKeyIv: encrypted?.iv ?? stored!.secretAccessKeyIv,
    secretAccessKeyVersion: encrypted?.version ?? stored!.secretAccessKeyVersion,
    lastBackupKey: changedLocation ? null : current.lastBackupKey,
    lastBackupAt: changedLocation ? null : current.lastBackupAt,
    lastBackupSizeBytes: changedLocation ? null : current.lastBackupSizeBytes,
    createdAt: timestamp,
    updatedAt: timestamp,
  }).onConflictDoUpdate({
    target: backupDestinations.id,
    set: {
      endpoint,
      region: body.region,
      bucket: body.bucket,
      prefix,
      accessKeyId: body.accessKeyId,
      ...(encrypted ? {
        secretAccessKeyCiphertext: encrypted.ciphertext,
        secretAccessKeyIv: encrypted.iv,
        secretAccessKeyVersion: encrypted.version,
      } : {}),
      ...(changedLocation ? {
        lastBackupKey: null,
        lastBackupAt: null,
        lastBackupSizeBytes: null,
      } : {}),
      updatedAt: timestamp,
    },
  })

  await writeAudit(env, {
    workspaceId: WORKSPACE_ID,
    actorId: member.user.id,
    action: 'backup.destination.update',
    targetType: 'workspace',
    targetId: WORKSPACE_ID,
    meta: {
      endpoint: new URL(endpoint).host,
      bucket: body.bucket,
      prefix,
      secret: plainSecret ? (current.secretConfigured ? 'updated' : 'configured') : 'unchanged',
    },
  })
  return { destination: backupDestinationDto(await loadBackupDestination(env, installationSecret)) }
})
