import type { AdminEnv } from '../env'
import { cloudflareToken, credentialStatus } from './credential'
import { sendHeartbeat } from './directory'
import { automaticUpdates, compareVersions, latestVersion, updateAdmin } from './releases'
import { listWorkspaces, updateWorkspace, type WorkspaceSummary } from './workspaces'

/**
 * Runs every fifteen minutes: keeps the Cloudflare grant fresh, applies
 * automatic updates the owner allowed, and reports to the directory.
 */
export async function runMaintenance(env: AdminEnv) {
  const credential = await credentialStatus(env)
  let workspaces: WorkspaceSummary[] | null = null
  if (credential.connected || credential.pendingHandover) {
    try {
      // Using the grant regularly keeps an OAuth refresh token from going idle.
      await cloudflareToken(env)
      workspaces = await listWorkspaces(env)
      const updates = await automaticUpdates(env)
      const latest = await latestVersion(env)
      if (updates.admin && latest && compareVersions(latest, env.LLLL_VERSION || '0.0.0') > 0) {
        await updateAdmin(env)
      }
      else if (updates.workspaces) {
        for (const workspace of workspaces.filter(item => item.updateAvailable)) {
          await updateWorkspace(env, workspace.workerName).catch(error => console.warn(`Automatic update of ${workspace.workerName} failed`, error))
        }
      }
    }
    catch (error) {
      console.warn('Admin maintenance could not use Cloudflare', error)
    }
  }
  await sendHeartbeat(env, workspaces).catch(error => console.warn('Directory heartbeat failed', error))
}
