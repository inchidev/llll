export type BackupDestinationDTO = {
  source?: 'binding' | 's3'
  configured: boolean
  endpoint: string | null
  region: string
  bucket: string | null
  prefix: string
  accessKeyId: string | null
  secretConfigured: boolean
  secretReadable: boolean
  lastBackupKey: string | null
  lastBackupAt: string | null
  lastBackupSizeBytes: number | null
  updatedAt: string | null
}

export type BucketBackupResultDTO = {
  key: string
  sizeBytes: number
  createdAt: string
}
