import { z } from 'zod'
import { cf, fail } from '../../../utils/cf'
import { requireMember } from '../../../utils/guards'
import { getServerId } from '../../../../shared/server-id'
import { parseBody } from '../../../utils/validate'
import { saveLizardConnection } from '../../../utils/lizard-connection'
import { lizardComputeStatus, startLizardCompute } from '../../../utils/lizard-control'
export default defineEventHandler(async event => {
  setHeader(event, 'Cache-Control', 'no-store')
  const { env } = cf(event), actor = await requireMember(event, await getServerId(env.DB))
  const input = parseBody(z.object({ apiKey: z.string().min(1).max(500), projectId: z.string().min(1).max(100) }).strict(), await readBody(event))
  if (env.LIZARD_COMPUTE_DO) {
    const status = await lizardComputeStatus(env, actor.authorization)
    if (status.phase !== 'stopped' || status.retainedStorage) fail(409, 'lizard_storage_retained', 'Stop Lizard compute and release retained task data before changing its connection.')
  }
  const saved = await saveLizardConnection(env, actor.authorization, input.apiKey, input.projectId)
  const compute = env.LIZARD_COMPUTE_DO ? await startLizardCompute(env, actor.authorization) : null
  return { ...saved, compute }
})
