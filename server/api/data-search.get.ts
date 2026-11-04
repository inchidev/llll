import { z } from 'zod'
import { getServerId } from '../../shared/server-id'
import { cf } from '../utils/cf'
import { requireMember } from '../utils/guards'
import { searchData } from '../utils/data-search'
import { parseBody } from '../utils/validate'

export default defineEventHandler(async event => {
  const { env } = cf(event)
  const actor = await requireMember(event, await getServerId(env.DB))
  const { q } = parseBody(z.object({ q: z.string().max(200).default('') }), getQuery(event))
  return { hits: await searchData(env, actor.authorization, q) }
})
