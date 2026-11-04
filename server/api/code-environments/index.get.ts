import { getServerId } from '../../../shared/server-id'
import { cf } from '../../utils/cf'
import { requireMember } from '../../utils/guards'
import { listCodeEnvironments } from '../../utils/code-environment-service'
import { gitAgentConfigured } from '../../utils/git-provider'

export default defineEventHandler(async event => {
  const { env } = cf(event)
  const actor = await requireMember(event, await getServerId(env.DB))
  return { deploymentConfigured: Boolean(env.GITHUB_AGENT_APP_ID && env.GITHUB_AGENT_APP_PRIVATE_KEY), configured: await gitAgentConfigured(env), environments: await listCodeEnvironments(env, actor.authorization) }
})
