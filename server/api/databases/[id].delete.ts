import { getServerId } from '../../../shared/server-id'
import { Permission } from '../../../shared/permissions'
import { cf } from '../../utils/cf'
import { requireMember } from '../../utils/guards'
import { changeDataTrash } from '../../utils/data-trash'

export default defineEventHandler(async event => {
  const { env } = cf(event)
  const actor = await requireMember(event, await getServerId(env.DB), Permission.manageDatabases)
  return changeDataTrash(env, actor.authorization, 'database', getRouterParam(event, 'id')!, 'trash')
})
