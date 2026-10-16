import { z } from 'zod'
import { WORKSPACE_ID } from '../../../shared/ids'
import { Permission } from '../../../shared/permissions'
import { cf } from '../../utils/cf'
import { updateDocument } from '../../utils/document-service'
import { requireMember } from '../../utils/guards'
import { parseBody } from '../../utils/validate'

const bodySchema = z.object({
  title: z.string().trim().min(1).max(160).optional(),
  content: z.string().max(1_000_000).optional(),
  version: z.number().int().positive(),
}).refine(body => body.title !== undefined || body.content !== undefined, 'No changes')

export default defineEventHandler(async (event) => {
  const actor = await requireMember(event, WORKSPACE_ID, Permission.manageDatabases)
  const id = getRouterParam(event, 'id')!
  const body = parseBody(bodySchema, await readBody(event))
  const { env } = cf(event)
  return { document: await updateDocument(env, actor.authorization, id, body) }
})
