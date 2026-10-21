import type { EncryptedSecret } from './encrypted-secret'

export type ServerUpdateStage = 'queued' | 'backing_up' | 'updating' | 'verifying' | 'complete' | 'failed' | 'attention' | 'cancelled'
export type UpdateBackup = { key: string; bucket: string; sizeBytes: number; sha256: string; createdAt: string; verified: boolean }
export type ServerUpdateJob = {
  id: string
  serverId: string
  requestedBy: string
  sourceVersion: string
  targetVersion: string
  stage: ServerUpdateStage
  buildId: string | null
  createdAt: string
  updatedAt: string
  backup: UpdateBackup | null
  error: string | null
}
export type ServerUpdateRecord = { schemaVersion: 1; hook: EncryptedSecret | null; job: ServerUpdateJob | null; backupToken: string | null; backupBusy: boolean }
export type UpdateStore = {
  read(): Promise<{ value: ServerUpdateRecord; revision: number | null }>
  write(value: ServerUpdateRecord, revision: number | null): Promise<boolean>
}
export const emptyUpdateRecord = (): ServerUpdateRecord => ({ schemaVersion: 1, hook: null, job: null, backupToken: null, backupBusy: false })
export const activeUpdate = (job: ServerUpdateJob | null) => Boolean(job && !['complete', 'cancelled', 'failed'].includes(job.stage))

/** Conditional writes serialize owner requests and Git Builds without a second control plane. */
export async function changeUpdateRecord(store: UpdateStore, change: (value: ServerUpdateRecord) => void) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const { value, revision } = await store.read()
    change(value)
    if (await store.write(value, revision)) return value
  }
  throw new Error('Another update request changed this Server. Refresh and try again.')
}

/** A hook can start only a Build. Never accept an arbitrary URL or send an API token. */
export function updateHookId(input: string): string {
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
  const value = input.trim()
  if (uuid.test(value)) return value.toLowerCase()
  const url = new URL(value)
  const match = /^\/client\/v4\/workers\/builds\/deploy_hooks\/([^/]+)$/.exec(url.pathname)
  if (url.protocol !== 'https:' || url.hostname !== 'api.cloudflare.com' || url.port || url.username || url.password || url.search || url.hash || !match || !uuid.test(match[1]!)) throw new Error('Enter a Cloudflare Workers Build deploy hook URL or ID')
  return match[1]!.toLowerCase()
}

export function readUpdateRecord(text: string): ServerUpdateRecord {
  const value = JSON.parse(text) as ServerUpdateRecord
  if (value.schemaVersion !== 1 || !('hook' in value) || !('job' in value)) throw new Error('Unrecognized update state; ask the Server operator to inspect it')
  return value
}

export function requestServerUpdate(record: ServerUpdateRecord, job: ServerUpdateJob) {
  if (record.job?.id === job.id) {
    if (record.job.targetVersion !== job.targetVersion || record.job.requestedBy !== job.requestedBy) throw new Error('This request ID belongs to another update')
    return
  }
  if (activeUpdate(record.job)) throw new Error('A Server update is already in progress')
  record.job = job
  record.backupToken = [...crypto.getRandomValues(new Uint8Array(32))].map(b => b.toString(16).padStart(2, '0')).join('')
  record.backupBusy = false
}
