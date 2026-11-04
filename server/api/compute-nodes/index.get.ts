import { cf } from '../../utils/cf'
import { requireMember } from '../../utils/guards'
import { getServerId } from '../../../shared/server-id'
import { listComputeNodes } from '../../utils/compute-nodes'
export default defineEventHandler(async event => {
  setHeader(event, 'Cache-Control', 'private, no-store')
  const { env } = cf(event), actor = await requireMember(event, await getServerId(env.DB))
  return { nodes: await listComputeNodes(env, actor.authorization) }
})
