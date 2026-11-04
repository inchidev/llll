import { z } from 'zod'
import { changeUpdateRecord } from '../../../../../shared/server-updates'
import { asRpc } from '../../../../../workers/env'
import { cloudflareAccessStatus } from '../../../../utils/cloudflare-account-access'
import { fail, originOk } from '../../../../utils/cf'
import { writeAudit } from '../../../../utils/messages'
import { SELF_EXECUTOR, updateRunnerName } from '../../../../utils/server-self-update'
import { updateConfiguration, updateOwner } from '../../../../utils/server-updates'
import { parseBody } from '../../../../utils/validate'

/**
 * Run a queued update on this Server with its kept Cloudflare access. It
 * continues in the background; a stopped update can be retried from where it
 * stopped, and the upload is idempotent.
 */
export default defineEventHandler(async (event) => {
  setHeader(event, 'Cache-Control', 'no-store')
  if (!await originOk(event)) fail(403, 'origin_denied', 'Start the update from this Server')
  const { env, serverId, member } = await updateOwner(event)
  const { requestId } = parseBody(z.object({ requestId: z.string().uuid() }), await readBody(event))
  if (!(await cloudflareAccessStatus(env)).connected) fail(409, 'cloudflare_access_missing', 'Connect Cloudflare to this Server to update from here')
  if (!env.SERVER_DO) fail(503, 'updates_unavailable', 'Background updates are unavailable on this Server')
  const { store } = await updateConfiguration(event, env, serverId)
  await changeUpdateRecord(store, record => {
    const job = record.job
    if (!job || job.id !== requestId || !['queued', 'attention'].includes(job.stage)) fail(409, 'update_not_runnable', 'Only a queued or stopped update can be run here')
    // A stopped update resumes after its verified backup; anything earlier starts over.
    job.stage = job.stage === 'attention' && job.backup?.verified ? 'updating' : 'backing_up'
    job.buildId = SELF_EXECUTOR + crypto.randomUUID()
    job.error = null
    job.updatedAt = new Date().toISOString()
  })
  await asRpc<{ runUpdate(): Promise<void> }>(env.SERVER_DO.getByName(updateRunnerName(serverId))).runUpdate()
  await writeAudit(env, { serverId, actorId: member.user.id, action: 'server.update.run', targetType: 'server', targetId: serverId, meta: { requestId } })
  return { job: (await store.read()).value.job }
})
