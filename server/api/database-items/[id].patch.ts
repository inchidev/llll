import { getServerId } from '../../../shared/server-id'
import { Permission } from '../../../shared/permissions'
import { cf } from '../../utils/cf'
import { requireMember } from '../../utils/guards'
import { updateRecord, updateRecordSchema } from '../../utils/record-service'
import { parseBody } from '../../utils/validate'

export default defineEventHandler(async (event) => {
  const { env } = cf(event)
  const actor = await requireMember(event, await getServerId(env.DB), Permission.writeData)
  return { item: await updateRecord(env, actor.authorization, getRouterParam(event, 'id')!, parseBody(updateRecordSchema, await readBody(event))) }
})
