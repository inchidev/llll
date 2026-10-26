import { z } from 'zod'
import { getServerId } from '../../../../shared/server-id'
import { completeGithubSetup } from '../../../utils/git-connections'
import { requireMember } from '../../../utils/guards'
import { cf } from '../../../utils/cf'
import { parseBody } from '../../../utils/validate'
export default defineEventHandler(async event=>{
 setHeader(event,'Cache-Control','private, no-store')
 setHeader(event,'Referrer-Policy','no-referrer')
 const {env}=cf(event),serverId=await getServerId(env.DB)
 const input=parseBody(z.object({code:z.string().max(200),state:z.string().max(64)}),getQuery(event))
 // A new top-level tab has a different cookie partition from an embedded Server.
 // Authenticate there before exchanging; keep the original Owner-bound state.
 let actor
 try { actor = await requireMember(event,serverId) }
 catch (error) {
  if ((error as { statusCode?: number }).statusCode !== 401) throw error
  return sendRedirect(event, '/git-connections/github/complete?' + new URLSearchParams(input))
 }
 await completeGithubSetup(env,actor.authorization,input.code,input.state)
 return sendRedirect(event,`/server/${serverId}/settings?section=repositories`)
})
