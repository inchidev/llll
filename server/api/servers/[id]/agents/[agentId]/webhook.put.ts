import { agentWebhookInput, type AgentWebhookDTO } from '../../../../../../shared/agent-webhooks'
import { requireManagedAgent } from '../../../../../utils/agent-webhook-access'
import { saveAgentWebhook } from '../../../../../utils/agent-webhooks'
import { cf } from '../../../../../utils/cf'
import { writeAudit } from '../../../../../utils/messages'
import { parseBody } from '../../../../../utils/validate'

export default defineEventHandler(async (event): Promise<{ webhook: AgentWebhookDTO }> => {
  const { serverId, agentId, actor } = await requireManagedAgent(event)
  const body = parseBody(agentWebhookInput, await readBody(event))
  const { env } = cf(event)
  const webhook = await saveAgentWebhook(env, agentId, actor.user.id, body)
  await writeAudit(env, { serverId, actorId: actor.user.id, action: 'agent.webhook.update', targetType: 'agent', targetId: agentId,
    meta: { host: new URL(webhook.url).host, headerName: webhook.headerName, keyChanged: Boolean(body.headerValue), replyTimeoutMinutes: webhook.replyTimeoutMinutes } })
  return { webhook }
})
