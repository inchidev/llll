import { cf } from '../../../utils/cf'
import { requireMember } from '../../../utils/guards'
import { getServerId } from '../../../../shared/server-id'
import { getLizardConnection } from '../../../utils/lizard-connection'
import { lizardComputeStatus } from '../../../utils/lizard-control'
export default defineEventHandler(async event => {
  setHeader(event, 'Cache-Control', 'no-store')
  const { env } = cf(event), actor = await requireMember(event, await getServerId(env.DB))
  const saved = await getLizardConnection(env, actor.authorization)
  const compute = saved.connection && env.LIZARD_COMPUTE_DO ? await lizardComputeStatus(env, actor.authorization) : null
  return { connection: saved.connection ? { ...saved.connection, executionAvailable: compute?.phase === 'ready' } : null, compute }
})
