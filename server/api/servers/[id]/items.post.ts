import { Permission } from '../../../../shared/permissions'
import { createItemSchema } from '../../../../shared/data-items'
import { creationSpaceId } from '../../../../shared/spaces'
import { cf } from '../../../utils/cf'
import { requireMember } from '../../../utils/guards'
import { createItem } from '../../../utils/item-service'
import { enforceActionLimit } from '../../../utils/route-gate'
import { parseBody } from '../../../utils/validate'
export default defineEventHandler(async event => {
 const { env } = cf(event)
 const actor = await requireMember(event, getRouterParam(event, 'id')!, Permission.writeData)
 const body = parseBody(createItemSchema, await readBody(event))
 // An Item given a Database is a record, and counts with the other ways of creating one.
 if (body.databaseId) await enforceActionLimit(event, 'record.create', actor.user.id, creationSpaceId(actor.authorization))
 return { item: await createItem(env, actor.authorization, body) }
})
