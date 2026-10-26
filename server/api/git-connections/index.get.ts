import { Permission, hasPermission } from '../../../shared/permissions'
import { getServerId } from '../../../shared/server-id'
import { listGitConnections } from '../../utils/git-connections'
import { requireMember } from '../../utils/guards'
import { cf, fail } from '../../utils/cf'
export default defineEventHandler(async event => {
 setHeader(event,'Cache-Control','private, no-store')
 const {env}=cf(event),actor=await requireMember(event,await getServerId(env.DB))
 if(!actor.isOwner&&!hasPermission(actor.perms,Permission.manageServer)&&!hasPermission(actor.perms,Permission.useComputer))fail(403,'git_denied','Repository configuration access is required')
 return {connections:await listGitConnections(env),canConfigure:actor.isOwner}
})
