import { getServerId } from '../../shared/server-id'
import { SERVER_BACKUP_BUCKET, readServerSetting } from '../../shared/server-settings'
import { z } from 'zod'
import { decryptSecret } from '../../shared/encrypted-secret'
import type { BackupDestinationDTO } from '../../shared/backups'
import type { L4Env } from '../../workers/env'

export const BACKUP_S3_SECRET_SCOPE = 'backup-s3-secret-access-key'

export const backupDestinationSchema = z.object({
  endpoint: z.string().trim().url('Enter a valid endpoint URL').max(1000)
    .refine(value => URL.canParse(value) && new URL(value).protocol === 'https:', 'Endpoint must use HTTPS')
    .refine((value) => {
      if (!URL.canParse(value)) return false
      const url = new URL(value)
      return !url.username && !url.password && !url.search && !url.hash
    }, 'Endpoint cannot contain credentials, a query, or a fragment'),
  region: z.string().trim().min(1, 'Region is required').max(100),
  bucket: z.string().trim().min(1, 'Bucket is required').max(255)
    .refine(value => !/[\s/\\]/u.test(value), 'Bucket cannot contain spaces or slashes')
    .refine(value => value !== '.' && value !== '..', 'Invalid bucket name'),
  prefix: z.string().trim().max(500)
    .refine(value => [...value].every((character) => {
      const code = character.charCodeAt(0)
      return code >= 32 && code !== 127
    }), 'Prefix cannot contain control characters')
    .refine(value => !value.split('/').some(segment => segment === '.' || segment === '..'), 'Prefix cannot contain . or .. path segments'),
  accessKeyId: z.string().trim().min(1, 'Access Key ID is required').max(1000),
  secretAccessKey: z.string().max(4000).optional(),
})

export type BackupDestinationInput = z.output<typeof backupDestinationSchema>

export type BackupDestinationRuntimeConfig = {
  bucketBinding?: R2Bucket
  endpoint: string
  region: string
  bucket: string
  prefix: string
  accessKeyId: string
  secretAccessKey: string
  secretConfigured: boolean
  secretReadable: boolean
  lastBackupKey: string | null
  lastBackupAt: string | null
  lastBackupSizeBytes: number | null
  updatedAt: string | null
}

type BackupDestinationRow = {
  endpoint: string
  region: string
  bucket: string
  prefix: string
  access_key_id: string
  secret_access_key_ciphertext: string
  secret_access_key_iv: string
  secret_access_key_version: number
  last_backup_key: string | null
  last_backup_at: string | null
  last_backup_size_bytes: number | null
  updated_at: string
}

export function normalizeBackupPrefix(value: string): string {
  return value.trim().replace(/^\/+|\/+$/gu, '')
}

export function normalizeBackupEndpoint(value: string): string {
  const url = new URL(value.trim())
  url.username = ''
  url.password = ''
  url.search = ''
  url.hash = ''
  url.pathname = url.pathname.replace(/\/+$/gu, '')
  return url.toString().replace(/\/$/u, '')
}

function blankDestination(): BackupDestinationRuntimeConfig {
  return {
    endpoint: '',
    region: 'auto',
    bucket: '',
    prefix: 'llll',
    accessKeyId: '',
    secretAccessKey: '',
    secretConfigured: false,
    secretReadable: true,
    lastBackupKey: null,
    lastBackupAt: null,
    lastBackupSizeBytes: null,
    updatedAt: null,
  }
}

export async function loadBackupDestination(
  env: L4Env,
  serverSecret = env.AUTH_SECRET?.trim() || '',
): Promise<BackupDestinationRuntimeConfig> {
  const fallback = async () => {
    if (!env.BACKUPS) return blankDestination()
    let bucket: string | null = null
    try { bucket = await readServerSetting(env.DB, SERVER_BACKUP_BUCKET) } catch { /* Fresh database. */ }
    return { ...blankDestination(), bucketBinding: env.BACKUPS, bucket: bucket || env.BACKUP_BUCKET_NAME || 'deployment-backups', prefix: `servers/${await getServerId(env.DB)}` }
  }
  let row: BackupDestinationRow | null
  try {
    row = await env.DB.prepare(
      `SELECT endpoint, region, bucket, prefix, access_key_id,
              secret_access_key_ciphertext, secret_access_key_iv, secret_access_key_version,
              last_backup_key, last_backup_at, last_backup_size_bytes, updated_at
       FROM backup_destinations WHERE id = 1`,
    ).first<BackupDestinationRow>()
  }
  catch {
    return fallback()
  }
  if (!row) return fallback()

  const config: BackupDestinationRuntimeConfig = {
    endpoint: row.endpoint,
    region: row.region,
    bucket: row.bucket,
    prefix: row.prefix,
    accessKeyId: row.access_key_id,
    secretAccessKey: '',
    secretConfigured: Boolean(row.secret_access_key_ciphertext),
    secretReadable: true,
    lastBackupKey: row.last_backup_key,
    lastBackupAt: row.last_backup_at,
    lastBackupSizeBytes: row.last_backup_size_bytes,
    updatedAt: row.updated_at,
  }
  if (!serverSecret) {
    config.secretReadable = false
    return config
  }
  try {
    config.secretAccessKey = await decryptSecret(serverSecret, BACKUP_S3_SECRET_SCOPE, {
      ciphertext: row.secret_access_key_ciphertext,
      iv: row.secret_access_key_iv,
      version: row.secret_access_key_version,
    })
  }
  catch {
    config.secretReadable = false
  }
  return config
}

export function backupDestinationConfigured(config: BackupDestinationRuntimeConfig): boolean {
  return Boolean(config.bucketBinding || (
    config.endpoint
    && config.region
    && config.bucket
    && config.accessKeyId
    && config.secretAccessKey
    && config.secretReadable
  ))
}

export function backupDestinationDto(config: BackupDestinationRuntimeConfig): BackupDestinationDTO {
  return {
    source: config.bucketBinding ? 'binding' : 's3',
    configured: backupDestinationConfigured(config),
    endpoint: config.endpoint || null,
    region: config.region || 'auto',
    bucket: config.bucket || null,
    prefix: config.prefix,
    accessKeyId: config.accessKeyId || null,
    secretConfigured: config.secretConfigured,
    secretReadable: config.secretReadable,
    lastBackupKey: config.lastBackupKey,
    lastBackupAt: config.lastBackupAt,
    lastBackupSizeBytes: config.lastBackupSizeBytes,
    updatedAt: config.updatedAt,
  }
}
