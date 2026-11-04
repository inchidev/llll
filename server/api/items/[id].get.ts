import { getServerId } from '../../../shared/server-id'
import { Permission } from '../../../shared/permissions'
import { cf } from '../../utils/cf'
import { requireMember } from '../../utils/guards'
import { getItem } from '../../utils/item-service'
export default defineEventHandler(async event => {
  const { env } = cf(event)
  const actor = await requireMember(event, await getServerId(env.DB), Permission.readData)
  return { item: await getItem(env, actor.authorization, getRouterParam(event, 'id')!) }
})
