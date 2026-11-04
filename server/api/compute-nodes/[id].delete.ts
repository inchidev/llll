import { cf } from '../../utils/cf'
import { requireMember } from '../../utils/guards'
import { getServerId } from '../../../shared/server-id'
import { disableComputeNode } from '../../utils/compute-nodes'
export default defineEventHandler(async event => {
  const { env } = cf(event), actor = await requireMember(event, await getServerId(env.DB))
  await disableComputeNode(env, actor.authorization, getRouterParam(event, 'id')!)
  return { disabled: true }
})
