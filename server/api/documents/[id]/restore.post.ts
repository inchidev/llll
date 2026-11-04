import { z } from 'zod'
import { getServerId } from '../../../../shared/server-id'
import { Permission } from '../../../../shared/permissions'
import { cf } from '../../../utils/cf'
import { requireMember } from '../../../utils/guards'
import { restoreDocumentRevision } from '../../../utils/document-revisions'
import { parseBody } from '../../../utils/validate'

const schema = z.object({ revision: z.number().int().positive(), version: z.number().int().positive() })
export default defineEventHandler(async event => {
  const { env } = cf(event)
  const actor = await requireMember(event, await getServerId(env.DB), Permission.writeData)
  const input = parseBody(schema, await readBody(event))
  return { document: await restoreDocumentRevision(env, actor.authorization, getRouterParam(event, 'id')!, input.revision, input.version) }
})
