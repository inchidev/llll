import { createTable, createTableSchema } from '../../../utils/table-service'
import { Permission } from '../../../../shared/permissions'
import { cf } from '../../../utils/cf'
import { requireMember } from '../../../utils/guards'
import { parseBody } from '../../../utils/validate'

export default defineEventHandler(async event => {
  const actor = await requireMember(event, getRouterParam(event, 'id')!, Permission.manageDatabases)
  return { database: await createTable(cf(event).env, actor.authorization, parseBody(createTableSchema, await readBody(event))) }
})
