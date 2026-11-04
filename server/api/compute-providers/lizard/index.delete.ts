import { cf, fail } from '../../../utils/cf'
import { requireMember } from '../../../utils/guards'
import { getServerId } from '../../../../shared/server-id'
import { removeLizardConnection } from '../../../utils/lizard-connection'
import { lizardComputeStatus } from '../../../utils/lizard-control'
export default defineEventHandler(async event => {
  setHeader(event, 'Cache-Control', 'no-store')
  const { env } = cf(event), actor = await requireMember(event, await getServerId(env.DB))
  if (env.LIZARD_COMPUTE_DO) {
    const status = await lizardComputeStatus(env, actor.authorization)
    if (status.phase !== 'stopped' || status.retainedStorage) fail(409, 'lizard_storage_retained', 'Stop Lizard compute and release retained task data before disconnecting.')
  }
  return removeLizardConnection(env, actor.authorization)
})
