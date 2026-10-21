import { Permission, hasPermission } from '../../../shared/permissions'
import { getServerId } from '../../../shared/server-id'
import { cf, fail } from '../../utils/cf'
import { requireMember } from '../../utils/guards'
import { listCodeEnvironments } from '../../utils/code-environment-service'
import { githubAgentConfigured } from '../../utils/github-agent-client'

export default defineEventHandler(async event => {
  const { env } = cf(event)
  const actor = await requireMember(event, await getServerId(env.DB))
  if (!actor.isOwner && !hasPermission(actor.perms, Permission.useComputer) && !hasPermission(actor.perms, Permission.manageServer) && !hasPermission(actor.perms, Permission.manageRoles)) fail(403, 'forbidden', 'Repository access is not granted')
  return { configured: githubAgentConfigured(env), environments: await listCodeEnvironments(env, actor.authorization) }
})
