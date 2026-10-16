import { cloudflareClient } from './cloudflare-client.js'
import { ensureR2 } from './deploy.js'
import { readL4Installation } from './installations.js'
import { createError } from './errors.js'
import { patchWorkerBindings } from './worker-settings.js'

/** Adds R2 to a running workspace without replacing its code, secrets, or other bindings. */
export async function enableL4Files(accessToken: string, accountId: string, workerName: string) {
  const installation = await readL4Installation(accessToken, accountId, workerName)
  if (!installation) throw createError({ statusCode: 404, statusMessage: 'Workspace not found in this Cloudflare account' })
  if (installation.resources.bucketName) return { bucketName: installation.resources.bucketName }
  const client = cloudflareClient(accessToken)
  const bucketName = await ensureR2(client, accountId, `${workerName}-files`)
  const settings = await client.workers.scripts.scriptAndVersionSettings.get(workerName, { account_id: accountId })
  // Re-read after provisioning, preserving bindings configured in the meantime.
  const bindings = (settings.bindings || []).filter(binding => binding.name !== 'FILES').map(binding => ({ type: 'inherit', name: binding.name }))
  await patchWorkerBindings(accessToken, accountId, workerName, [...bindings, { type: 'r2_bucket', name: 'FILES', bucket_name: bucketName }])
  return { bucketName }
}
