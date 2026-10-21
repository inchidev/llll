import { z } from 'zod'
import { changeUpdateRecord, requestServerUpdate, type ServerUpdateJob } from '../../../../../shared/server-updates'
import { compareVersions } from '../../../../../shared/release-version'
import { version } from '../../../../../package.json'
import { updateConfiguration, updateOwner, triggerServerUpdate } from '../../../../utils/server-updates'
import { fail } from '../../../../utils/cf'
import { llllReleases } from '../../../../utils/releases'
import { parseBody } from '../../../../utils/validate'
import { writeAudit } from '../../../../utils/messages'

export default defineEventHandler(async (event) => {
  const { env, serverId, member } = await updateOwner(event)
  const body = parseBody(z.object({ requestId: z.string().uuid(), release: z.string().regex(/^v\d+\.\d+\.\d+(?:-(?:alpha|beta|rc)\.\d+)?$/), prereleases: z.boolean().default(false) }), await readBody(event))
  const { store, hook, value } = await updateConfiguration(event, env, serverId)
  if (value.job?.id === body.requestId) {
    if (value.job.targetVersion !== body.release.slice(1) || value.job.requestedBy !== member.user.id) fail(409, 'request_conflict', 'This request ID belongs to another update')
    return { job: value.job }
  }
  if (!hook) fail(409, 'build_hook_required', 'Connect this Server’s L4 Build hook first')
  const installed = env.LLLL_VERSION?.trim() || version
  if (compareVersions(body.release.slice(1), installed) <= 0) fail(400, 'release_not_newer', 'Choose a release newer than the installed version')
  const releases = await llllReleases(undefined, { prereleases: body.prereleases, installable: true })
  if (!releases.some(r => r.tagName === body.release)) fail(400, 'release_unavailable', 'Choose an available published L4 release')
  const now = new Date().toISOString()
  const job: ServerUpdateJob = { id: body.requestId, serverId, requestedBy: member.user.id, sourceVersion: installed, targetVersion: body.release.slice(1), stage: 'queued', buildId: null, createdAt: now, updatedAt: now, backup: null, error: null }
  let created = false
  await changeUpdateRecord(store, record => {
    created = record.job?.id !== job.id
    try { requestServerUpdate(record, job) } catch (error) { fail(409, 'update_active', error instanceof Error ? error.message : 'An update is already in progress') }
  })
  if (created) {
    await writeAudit(env, { serverId, actorId: member.user.id, action: 'server.update.request', targetType: 'server', targetId: serverId, meta: { requestId: job.id, release: job.targetVersion } })
    await triggerServerUpdate(store, job.id, hook)
  }
  return { job: (await store.read()).value.job }
})
