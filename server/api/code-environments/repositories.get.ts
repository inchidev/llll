import { getServerId } from '../../../shared/server-id'
import { Permission } from '../../../shared/permissions'
import { resourceAllowed } from '../../../shared/authorization'
import { cf } from '../../utils/cf'
import { requireMember } from '../../utils/guards'
import { discoverRepositories, gitAgentConfigured } from '../../utils/git-provider'

export default defineEventHandler(async event => {
  const { env } = cf(event)
  const actor = await requireMember(event, await getServerId(env.DB), Permission.manageServer)
  const connectionId = getQuery(event).connectionId
  if (connectionId !== undefined && (typeof connectionId !== 'string' || !/^[a-f0-9-]{36}$/u.test(connectionId))) throw createError({ statusCode: 400, message: 'Invalid Git connection' })
  // Discovery fails closed for a disabled or unreadable connection rather than listing nothing.
  const repositories = await discoverRepositories(env, connectionId as string | undefined)
  return { configured: await gitAgentConfigured(env, connectionId as string | undefined), repositories: repositories.filter(repo => resourceAllowed(actor.authorization, 'repositories', repo.resourceId)) }
})
