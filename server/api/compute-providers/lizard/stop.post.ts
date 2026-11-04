import { cf } from '../../../utils/cf'
import { requireMember } from '../../../utils/guards'
import { getServerId } from '../../../../shared/server-id'
import { stopLizardCompute } from '../../../utils/lizard-control'
export default defineEventHandler(async event => {
  setHeader(event, 'Cache-Control', 'no-store')
  const { env } = cf(event), actor = await requireMember(event, await getServerId(env.DB))
  return { compute: await stopLizardCompute(env, actor.authorization) }
})
