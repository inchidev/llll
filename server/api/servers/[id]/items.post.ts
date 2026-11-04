import { Permission } from '../../../../shared/permissions'
import { createItemSchema } from '../../../../shared/data-items'
import { cf } from '../../../utils/cf'
import { requireMember } from '../../../utils/guards'
import { createItem } from '../../../utils/item-service'
import { parseBody } from '../../../utils/validate'
export default defineEventHandler(async event => {
 const { env } = cf(event)
 const actor = await requireMember(event, getRouterParam(event, 'id')!, Permission.writeData)
 return { item: await createItem(env, actor.authorization, parseBody(createItemSchema, await readBody(event))) }
})
