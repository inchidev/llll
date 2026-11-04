import { describe, expect, it } from 'vitest'
import { encryptSecret } from '../../shared/encrypted-secret'
import {
  BACKUP_S3_SECRET_SCOPE,
  backupDestinationSchema,
  backupDestinationDto,
  loadBackupDestination,
  normalizeBackupEndpoint,
  normalizeBackupPrefix,
} from '../../server/utils/backup-destination'
import type { L4Env } from '../../workers/env'

describe('backup destination settings', () => {
  it('returns validation errors for malformed endpoints instead of throwing', () => {
    for (const endpoint of ['', 'not a URL', 'http://insecure.example', 'https://user:secret@example.com']) {
      expect(backupDestinationSchema.safeParse({ endpoint, region: 'auto', bucket: 'backups', prefix: '', accessKeyId: 'id' }).success).toBe(false)
    }
  })

  it('normalizes endpoints and prefixes', () => {
    expect(normalizeBackupEndpoint(' https://s3.example.com/base/// ')).toBe('https://s3.example.com/base')
    expect(normalizeBackupPrefix(' /llll/main/ ')).toBe('llll/main')
  })

  it('decrypts the saved secret but never includes it in the admin DTO', async () => {
    const serverSecret = 'stable server secret'
    const encrypted = await encryptSecret(serverSecret, BACKUP_S3_SECRET_SCOPE, 's3-secret')
    const env = {
      DB: {
        prepare: () => ({
          first: async () => ({
            endpoint: 'https://s3.example.com',
            region: 'eu-west-1',
            bucket: 'backup-bucket',
            prefix: 'llll',
            access_key_id: 'access-id',
            secret_access_key_ciphertext: encrypted.ciphertext,
            secret_access_key_iv: encrypted.iv,
            secret_access_key_version: encrypted.version,
            last_backup_key: null,
            last_backup_at: null,
            last_backup_size_bytes: null,
            updated_at: '2026-09-05T00:00:00.000Z',
          }),
        }),
      },
    } as unknown as L4Env

    const loaded = await loadBackupDestination(env, serverSecret)
    expect(loaded.secretAccessKey).toBe('s3-secret')
    expect(loaded.secretReadable).toBe(true)
    expect(backupDestinationDto(loaded)).not.toHaveProperty('secretAccessKey')
  })

  it('marks a saved secret unreadable after AUTH_SECRET changes', async () => {
    const encrypted = await encryptSecret('original secret', BACKUP_S3_SECRET_SCOPE, 's3-secret')
    const env = {
      DB: {
        prepare: () => ({
          first: async () => ({
            endpoint: 'https://s3.example.com',
            region: 'auto',
            bucket: 'backup-bucket',
            prefix: 'llll',
            access_key_id: 'access-id',
            secret_access_key_ciphertext: encrypted.ciphertext,
            secret_access_key_iv: encrypted.iv,
            secret_access_key_version: encrypted.version,
            last_backup_key: null,
            last_backup_at: null,
            last_backup_size_bytes: null,
            updated_at: '2026-09-05T00:00:00.000Z',
          }),
        }),
      },
    } as unknown as L4Env

    const loaded = await loadBackupDestination(env, 'replacement secret')
    expect(loaded.secretAccessKey).toBe('')
    expect(loaded.secretReadable).toBe(false)
    expect(backupDestinationDto(loaded).configured).toBe(false)
  })
})
