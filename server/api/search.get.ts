import { z } from 'zod'
import { getServerId } from '../../shared/server-id'
import { dataHitPath } from '../../shared/link-previews'
import type { GlobalSearchHit } from '../../shared/global-search'
import { cf } from '../utils/cf'
import { requireMember } from '../utils/guards'
import { parseBody } from '../utils/validate'
import { searchData } from '../utils/data-search'
import { messageSearchExpression, searchServerMessages } from '../utils/message-search'

export default defineEventHandler(async event => {
  const { env } = cf(event)
  const member = await requireMember(event, await getServerId(env.DB))
  const { q } = parseBody(z.object({ q: z.string().trim().min(2).max(120) }), getQuery(event))
  setHeader(event, 'Cache-Control', 'private, no-store')
  const [resources, messages] = await Promise.all([
    searchData(env, member.authorization, q),
    messageSearchExpression(q) ? searchServerMessages(env, member, { q, limit: 12 }) : { hits: [] },
  ])
  const hits: GlobalSearchHit[] = resources.map(hit => ({ id: hit.id, kind: hit.type, title: hit.title || 'Untitled', path: dataHitPath(hit) }))
  hits.push(...messages.hits.map(hit => ({
    id: hit.id, kind: 'message' as const, title: hit.content.slice(0, 240),
    description: `${hit.author.displayName} · ${hit.channel.title}`,
    path: `${hit.channel.path}${hit.channel.path.includes('?') ? '&' : '?'}message=${encodeURIComponent(hit.id)}`,
  })))
  return { hits }
})
