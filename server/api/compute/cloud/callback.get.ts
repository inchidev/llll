import { z } from 'zod'
import { cf } from '../../../utils/cf'
import { requireMember } from '../../../utils/guards'
import { getServerId } from '../../../../shared/server-id'
import { completeL4ComputeLink } from '../../../utils/l4-compute'

/**
 * llll.gg brings the Owner's browser back here with a code and the nonce the connect step minted. The Server
 * exchanges the code server to server and returns the browser to Settings → Compute, which says how it went.
 */
export default defineEventHandler(async event => {
  setHeader(event, 'Cache-Control', 'private, no-store')
  const { env } = cf(event), serverId = await getServerId(env.DB), actor = await requireMember(event, serverId)
  const query = z.object({ code: z.string().min(1).max(4096), state: z.string().regex(/^[a-f0-9]{64}$/u) }).safeParse(getQuery(event))
  const settings = new URL(`/server/${serverId}/settings`, env.PUBLIC_ORIGIN || 'http://localhost')
  settings.searchParams.set('section', 'compute')
  if (!query.success) {
    settings.searchParams.set('l4', 'failed')
    settings.searchParams.set('message', 'llll.gg returned without a link code')
    return sendRedirect(event, settings.pathname + settings.search, 303)
  }
  try {
    await completeL4ComputeLink(env, actor.authorization, query.data.code, query.data.state)
    settings.searchParams.set('l4', 'linked')
  } catch (error) {
    settings.searchParams.set('l4', 'failed')
    settings.searchParams.set('message', (error as { data?: { error?: { message?: string } } })?.data?.error?.message || 'The link was not completed')
  }
  return sendRedirect(event, settings.pathname + settings.search, 303)
})
