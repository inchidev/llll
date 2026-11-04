import { getServerId } from '../../../../shared/server-id'
import { Permission } from '../../../../shared/permissions'
import { cf } from '../../../utils/cf'
import { requireMember } from '../../../utils/guards'
import { moveItem } from '../../../utils/item-service'
import { moveItemSchema } from '../../../../shared/data-items'
import { parseBody } from '../../../utils/validate'
export default defineEventHandler(async event => {
 const { env } = cf(event)
 const actor = await requireMember(event, await getServerId(env.DB), Permission.manageDatabases)
 return { item: await moveItem(env, actor.authorization, getRouterParam(event, 'id')!, parseBody(moveItemSchema, await readBody(event))) }
})
