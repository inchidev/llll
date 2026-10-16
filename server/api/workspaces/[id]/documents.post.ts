import { z } from 'zod'
import { Permission } from '../../../../shared/permissions'
import { cf } from '../../../utils/cf'
import { createDocument } from '../../../utils/document-service'
import { requireMember } from '../../../utils/guards'
import { parseBody } from '../../../utils/validate'

const bodySchema = z.object({ title: z.string().trim().min(1).max(160) })

export default defineEventHandler(async (event) => {
  const workspaceId = getRouterParam(event, 'id')!
  const actor = await requireMember(event, workspaceId, Permission.manageDatabases)
  const body = parseBody(bodySchema, await readBody(event))
  const { env } = cf(event)
  return { document: await createDocument(env, actor.authorization, body) }
})
