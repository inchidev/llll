import { fileStorage } from '../../shared/file-storage'
import type { L4Env } from '../../workers/env'
import { createStorageBackup } from '../../shared/storage-backup'
export function createServerBackup(env: L4Env, createdAt: string, version: string) {
  return createStorageBackup(env.DB, fileStorage(env), createdAt, version)
}
