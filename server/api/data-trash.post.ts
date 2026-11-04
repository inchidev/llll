import { z } from 'zod'
import { Permission } from '../../shared/permissions'
import { DataTrashTypes } from '../../shared/data-trash'
import { getServerId } from '../../shared/server-id'
import { cf } from '../utils/cf'
import { requireMember } from '../utils/guards'
import { changeDataTrash } from '../utils/data-trash'
import { parseBody } from '../utils/validate'

const schema = z.object({ type: z.enum(DataTrashTypes), id: z.string().min(1), action: z.enum(['restore', 'purge']) })
export default defineEventHandler(async event => {
  const { env } = cf(event)
  const actor = await requireMember(event, await getServerId(env.DB), Permission.manageDatabases)
  const input = parseBody(schema, await readBody(event))
  return changeDataTrash(env, actor.authorization, input.type, input.id, input.action)
})
