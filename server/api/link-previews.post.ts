import { z } from 'zod'
import { getServerId } from '../../shared/server-id'
import { cf } from '../utils/cf'
import { requireMember } from '../utils/guards'
import { parseBody } from '../utils/validate'
import { linkPreview } from '../utils/link-previews'
import { requireRateLimit } from '../utils/rate-limit'

export default defineEventHandler(async event => {
  const { env } = cf(event)
  const member = await requireMember(event, await getServerId(env.DB))
  const body = parseBody(z.object({ urls: z.array(z.string().min(1).max(2048)).max(3) }), await readBody(event))
  await requireRateLimit(event, [{ key: `link-previews:${member.user.id}`, limit: 90, windowMs: 60_000 }], 'Too many previews. Try again shortly.')
  setHeader(event, 'Cache-Control', 'private, no-store')
  const origin = getRequestURL(event).origin
  const previews = await Promise.all(body.urls.map(async url => {
    try { return await linkPreview(env, member, url, origin) }
    catch { return null }
  }))
  return { previews: previews.filter(preview => preview !== null) }
})
