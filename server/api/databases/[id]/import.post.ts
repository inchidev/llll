import { Permission } from '../../../../shared/permissions'
import { getServerId } from '../../../../shared/server-id'
import { cf } from '../../../utils/cf'
import { requireMember } from '../../../utils/guards'
import { bulkCreateRecords, bulkRecordsSchema } from '../../../utils/data-transfer'
import { parseBody } from '../../../utils/validate'

export default defineEventHandler(async event => {
  const { env } = cf(event)
  const actor = await requireMember(event, await getServerId(env.DB), Permission.writeData)
  const body = parseBody(bulkRecordsSchema.omit({ databaseId: true }), await readBody(event))
  return bulkCreateRecords(env, actor.authorization, { ...body, databaseId: getRouterParam(event, 'id')! })
})
