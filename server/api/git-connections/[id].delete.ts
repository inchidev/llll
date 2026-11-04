import { getServerId } from '../../../shared/server-id'
import { disableGitConnection } from '../../utils/git-connections'
import { requireMember } from '../../utils/guards'
import { cf, fail, originOk } from '../../utils/cf'
export default defineEventHandler(async event=>{
 setHeader(event,'Cache-Control','private, no-store')
 if(!await originOk(event))fail(403,'origin_denied','Manage Git connections from this Server')
 const {env}=cf(event),actor=await requireMember(event,await getServerId(env.DB))
 await disableGitConnection(env,actor.authorization,getRouterParam(event,'id')!)
 return {ok:true}
})
