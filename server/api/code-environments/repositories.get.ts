import { getServerId } from '../../../shared/server-id'
import { Permission } from '../../../shared/permissions'
import { resourceAllowed } from '../../../shared/authorization'
import { cf } from '../../utils/cf'
import { requireMember } from '../../utils/guards'
import { agentRepositories, githubAgentConfigured } from '../../utils/github-agent-client'

export default defineEventHandler(async event => {
  const { env } = cf(event)
  const actor = await requireMember(event, await getServerId(env.DB), Permission.manageServer)
  const connectionId = getQuery(event).connectionId
  if (connectionId !== undefined && (typeof connectionId !== 'string' || !/^[a-f0-9-]{36}$/u.test(connectionId))) throw createError({ statusCode: 400, message: 'Invalid Git connection' })
  return { configured: await githubAgentConfigured(env, connectionId as string | undefined), repositories: (await agentRepositories(env, fetch, connectionId as string | undefined)).filter(repo => resourceAllowed(actor.authorization, 'repositories', String(repo.id))) }
})
