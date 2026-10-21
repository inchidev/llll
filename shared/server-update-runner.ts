import { activeUpdate, changeUpdateRecord, type ServerUpdateJob, type UpdateBackup, type UpdateStore } from './server-updates'
import { compareVersions } from './release-version'

type Dependencies = {
  store: UpdateStore
  serverId: string
  buildId: string
  installedVersion(): Promise<string>
  previousBuildStopped(id: string): Promise<boolean>
  prepare(target: string): Promise<void>
  backup(job: ServerUpdateJob): Promise<UpdateBackup>
  deploy(target: string): Promise<void>
  verify(job: ServerUpdateJob): Promise<void>
}

/** Only a Git-connected Build runs these effects; the Server has no account API token. */
export async function executeServerUpdate(d: Dependencies): Promise<boolean> {
  const first = (await d.store.read()).value.job
  if (!first || !activeUpdate(first)) return false
  if (first.serverId !== d.serverId) throw new Error('Update request belongs to another Server')
  if (first.buildId === d.buildId) return true // The operation is already owned by this Build.
  if (first.buildId && first.buildId !== d.buildId && !await d.previousBuildStopped(first.buildId)) throw new Error('The preceding Build has not stopped; refusing a concurrent deployment')
  const resuming = first.stage !== 'queued'
  if (resuming && !first.buildId) throw new Error('Missing Build ownership; ask the operator to inspect this request')
  let owned = false
  await changeUpdateRecord(d.store, record => {
    owned = false
    if (record.job?.id !== first.id || record.job.stage !== first.stage || record.job.buildId !== first.buildId) return
    record.job.stage = 'backing_up'
    record.job.buildId = d.buildId
    record.job.error = null
    record.job.updatedAt = new Date().toISOString()
    record.backupBusy = false
    record.backupToken = [...crypto.getRandomValues(new Uint8Array(32))].map(b => b.toString(16).padStart(2, '0')).join('')
    owned = true
  })
  if (!owned) return true
  let deploymentStarted = ['updating', 'verifying', 'attention'].includes(first.stage)
  async function update(change: (job: ServerUpdateJob) => void) {
    await changeUpdateRecord(d.store, record => {
      if (record.job?.id !== first!.id || record.job.buildId !== d.buildId) throw new Error('Update ownership changed')
      change(record.job)
      record.job.updatedAt = new Date().toISOString()
      if (['complete', 'failed'].includes(record.job.stage)) { record.backupToken = null; record.backupBusy = false }
    })
  }
  try {
    const installed = await d.installedVersion()
    const comparison = compareVersions(first.targetVersion, installed)
    if (comparison < 0) throw new Error('Refusing to downgrade this Server')
    if (comparison === 0 && !resuming) throw new Error('The selected release is already installed')
    if (comparison > 0) {
      await d.prepare(first.targetVersion)
      await update(job => { job.backup = null })
      const backup = await d.backup(first)
      if (!backup.verified || !/^[a-f0-9]{64}$/.test(backup.sha256) || backup.sizeBytes <= 0) throw new Error('Backup verification failed')
      await update(job => { job.backup = backup; job.stage = 'updating' })
      deploymentStarted = true
      await d.deploy(first.targetVersion)
    } else {
      // Reconcile an ambiguous deployment only after the preceding Build stopped.
      deploymentStarted = true
      if (!first.backup?.verified) throw new Error('Missing verified backup receipt')
    }
    await update(job => { job.stage = 'verifying' })
    await d.verify(first)
    await update(job => { job.stage = 'complete'; job.error = null })
  } catch {
    await update(job => {
      job.stage = deploymentStarted ? 'attention' : 'failed'
      job.error = deploymentStarted
        ? 'Deployment needs verification. Open the Build log or retry verification after that Build stops. Do not start a different update.'
        : 'The update stopped before deployment. Check the Build log and retry with a new request. Your installed Worker is unchanged.'
    })
    throw new Error('Server update did not complete; inspect the Git-connected Build log')
  }
  return true
}
