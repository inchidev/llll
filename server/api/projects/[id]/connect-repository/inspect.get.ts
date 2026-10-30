import { z } from 'zod'
import { inspectRepository } from '../../../../utils/repository-connect'
import { requireMember } from '../../../../utils/guards'
import { getServerId } from '../../../../../shared/server-id'
import { cf } from '../../../../utils/cf'
import { parseBody } from '../../../../utils/validate'
const query = z.object({ connectionId: z.string().uuid().optional(), repositoryId: z.coerce.number().int().positive() })
export default defineEventHandler(async event => {
  setHeader(event, 'Cache-Control', 'private, no-store')
  const { env } = cf(event), actor = await requireMember(event, await getServerId(env.DB))
  const input = parseBody(query, getQuery(event))
  return inspectRepository(env, actor.authorization, getRouterParam(event, 'id')!, input.connectionId ?? null, input.repositoryId)
})
