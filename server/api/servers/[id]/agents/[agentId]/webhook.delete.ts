import { requireManagedAgent } from '../../../../../utils/agent-webhook-access'
import { deleteAgentWebhook } from '../../../../../utils/agent-webhooks'
import { cf } from '../../../../../utils/cf'
import { writeAudit } from '../../../../../utils/messages'

export default defineEventHandler(async (event): Promise<{ ok: true }> => {
  const { serverId, agentId, actor } = await requireManagedAgent(event)
  const { env } = cf(event)
  if (await deleteAgentWebhook(env, agentId)) {
    await writeAudit(env, { serverId, actorId: actor.user.id, action: 'agent.webhook.delete', targetType: 'agent', targetId: agentId, meta: {} })
  }
  return { ok: true }
})
