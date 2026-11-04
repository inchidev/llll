import { Permission } from '../../../../shared/permissions'
import { cf } from '../../../utils/cf'
import { requireMember } from '../../../utils/guards'
import { listItems } from '../../../utils/item-service'
export default defineEventHandler(async event => {
 const { env } = cf(event)
 const actor = await requireMember(event, getRouterParam(event, 'id')!, Permission.readData)
 return { items: await listItems(env, actor.authorization) }
})
