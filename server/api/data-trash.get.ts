import { Permission } from '../../shared/permissions'
import { getServerId } from '../../shared/server-id'
import { cf } from '../utils/cf'
import { requireMember } from '../utils/guards'
import { listDataTrash } from '../utils/data-trash'

export default defineEventHandler(async event => {
  const { env } = cf(event)
  const actor = await requireMember(event, await getServerId(env.DB), Permission.manageDatabases)
  return { entries: await listDataTrash(env, actor.authorization) }
})
