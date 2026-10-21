import { z } from 'zod'
import { activeUpdate, changeUpdateRecord } from '../../../../../shared/server-updates'
import { assertQueuedJob, updateConfiguration, updateOwner, triggerServerUpdate } from '../../../../utils/server-updates'
import { parseBody } from '../../../../utils/validate'
import { fail } from '../../../../utils/cf'
import { writeAudit } from '../../../../utils/messages'

export default defineEventHandler(async (event) => {
  const { env, serverId, member } = await updateOwner(event)
  const body = parseBody(z.object({ requestId: z.string().uuid(), cancel: z.boolean().default(false) }), await readBody(event))
  const { store, hook } = await updateConfiguration(event, env, serverId)
  await changeUpdateRecord(store, record => {
    if (body.cancel) assertQueuedJob(record, body.requestId)
    else if (record.job?.id !== body.requestId || !activeUpdate(record.job)) fail(409, 'update_not_active', 'This request is no longer active')
    if (body.cancel) { record.job!.stage = 'cancelled'; record.job!.updatedAt = new Date().toISOString(); record.backupToken = null; record.backupBusy = false }
  })
  await writeAudit(env, { serverId, actorId: member.user.id, action: body.cancel ? 'server.update.cancel' : 'server.update.resume', targetType: 'server', targetId: serverId, meta: { requestId: body.requestId } })
  if (!body.cancel) {
    if (!hook) fail(409, 'build_hook_required', 'Reconnect the Build hook')
    await triggerServerUpdate(store, body.requestId, hook)
  }
  return { job: (await store.read()).value.job }
})
