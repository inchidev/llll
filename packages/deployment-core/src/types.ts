export type CloudflareAccount = {
  id: string
  name: string
  type: 'standard' | 'enterprise'
}

export type CloudflareZone = {
  id: string
  accountId: string
  name: string
  status: string
}

export type DeployRequest = {
  accountId: string
  /** The one UUID used by the Worker, its resources and server_identity. */
  serverId: string
  workerName: string
  adminEmail: string
  allowedEmails: string[]
  appName: string
  authMode: 'access' | 'builtin'
  registrationMode: 'invite_only' | 'open'
  customDomainEnabled: boolean
  zoneId: string
  zoneName: string
  appSubdomain: string
  mailEnabled: boolean
  mailSubdomain: string
  mailLocalPart: string
  targetVersion?: string
  /** New installs may omit R2; existing storage is always preserved. */
  filesEnabled?: boolean
  backupBucketName?: string
}

export type BaseInstallRequest = Pick<DeployRequest,
  'accountId' | 'serverId' | 'workerName' | 'adminEmail' | 'allowedEmails' | 'appName' | 'authMode' | 'registrationMode' | 'targetVersion' | 'filesEnabled' | 'backupBucketName'
>

export type DeployResponse = {
  url: string
  setupUrl?: string
  version: string
  updated: boolean
  appliedMigrations: string[]
  verified: boolean
}

export type CloudflareServer = {
  accountId: string
  workerName: string
  origin: string
  version: string | null
  configuration: DeployRequest
  resources: {
    databaseId: string | null
    bucketName: string | null
    backupBucketName: string | null
    kvId: string | null
    mailZoneId: string | null
    mailDomain: string | null
    accessApplicationId: string | null
    accessHealthApplicationId: string | null
    accessDeletionApplicationId: string | null
  }
}

export type DeployProgressStep =
  | 'account'
  | 'release'
  | 'server'
  | 'storage'
  | 'database'
  | 'assets'
  | 'access'
  | 'worker'
  | 'domain'
  | 'mail'
  | 'schedule'
  | 'verify'

export type DeployProgressEvent = {
  type: 'progress'
  step: DeployProgressStep
  state: 'active' | 'complete'
  detail?: string
} | {
  type: 'complete'
  result: DeployResponse
} | {
  type: 'error'
  message: string
}

export type DeployProgressReporter = (event: Extract<DeployProgressEvent, { type: 'progress' }>) => void | Promise<void>

export type ReleaseAsset = {
  url: string
  sha256: string
  size: number
}

export type InstallerReleaseManifest = {
  schemaVersion: 1
  version: string
  releasedAt: string
  compatibilityDate: string
  compatibilityFlags: string[]
  capabilities?: string[]
  factory?: ReleaseAsset
  worker: ReleaseAsset
  assets: ReleaseAsset
  durableObjectMigrations?: Array<{ tag: string; new_sqlite_classes?: string[]; deleted_classes?: string[] }>
  removedBindings?: string[]
  durableObjects: Array<{
    binding: string
    className: string
    migration: string
  }>
}

export type InstallerAssetsPayload = {
  assets: Array<{
    path: string
    hash: string
    size: number
    contentType: string
    contentBase64: string
  }>
  migrations: Array<{
    name: string
    sql: string
  }>
}

export type InstallerRelease = {
  manifest: InstallerReleaseManifest
  worker: ArrayBuffer
  assets: InstallerAssetsPayload
}
