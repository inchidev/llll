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
  'accountId' | 'workerName' | 'adminEmail' | 'allowedEmails' | 'appName' | 'authMode' | 'registrationMode' | 'targetVersion' | 'filesEnabled' | 'backupBucketName'
>

export type DeployResponse = {
  url: string
  setupUrl?: string
  version: string
  updated: boolean
  appliedMigrations: string[]
  verified: boolean
  /** The update linked the workspace to the account's L4 Admin. */
  linkedToAdmin?: boolean
}

export type InstallationControl = {
  id: string
  token: string
  endpoint: string
}

export type CloudflareInstallation = {
  accountId: string
  workerName: string
  origin: string
  version: string | null
  configuration: DeployRequest
  resources: {
    databaseId: string | null
    primary: boolean
    bucketName: string | null
    kvId: string | null
    mailZoneId: string | null
    mailDomain: string | null
    telemetryId: string | null
    accessApplicationId: string | null
    accessHealthApplicationId: string | null
    accessDeletionApplicationId: string | null
    /** Linked to this account's L4 Admin. */
    admin: boolean
  }
}

export type DeployProgressStep =
  | 'account'
  | 'release'
  | 'installation'
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

/** The L4 Admin published in the same release as the workspace. */
export type AdminReleaseManifest = {
  version: string
  compatibilityDate: string
  compatibilityFlags: string[]
  worker: ReleaseAsset
  assets: ReleaseAsset
  durableObjects: Array<{
    binding: string
    className: string
    migration: string
  }>
}

export type InstallerReleaseManifest = {
  schemaVersion: 1
  version: string
  releasedAt: string
  compatibilityDate: string
  compatibilityFlags: string[]
  capabilities?: string[]
  worker: ReleaseAsset
  assets: ReleaseAsset
  durableObjects: Array<{
    binding: string
    className: string
    migration: string
  }>
  /** Present from the first release that ships a L4 Admin. */
  admin?: AdminReleaseManifest
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

export type AdminRelease = {
  manifest: AdminReleaseManifest
  worker: ArrayBuffer
  assets: InstallerAssetsPayload
}
