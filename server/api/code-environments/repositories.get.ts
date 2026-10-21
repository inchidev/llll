import { getServerId } from '../../../shared/server-id'
import { Permission } from '../../../shared/permissions'
import { resourceAllowed } from '../../../shared/authorization'
import { cf } from '../../utils/cf'
import { requireMember } from '../../utils/guards'
import { agentRepositories, githubAgentConfigured } from '../../utils/github-agent-client'

export default defineEventHandler(async event => {
  const { env } = cf(event)
  const actor = await requireMember(event, await getServerId(env.DB), Permission.manageServer)
  return { configured: githubAgentConfigured(env), repositories: (await agentRepositories(env)).filter(repo => resourceAllowed(actor.authorization, 'repositories', String(repo.id))) }
})
