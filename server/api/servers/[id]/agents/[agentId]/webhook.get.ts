import type { AgentWebhookDTO } from '../../../../../../shared/agent-webhooks'
import { requireManagedAgent } from '../../../../../utils/agent-webhook-access'
import { agentWebhook, agentWebhookDTO } from '../../../../../utils/agent-webhooks'
import { cf } from '../../../../../utils/cf'

export default defineEventHandler(async (event): Promise<{ webhook: AgentWebhookDTO | null }> => {
  const { agentId } = await requireManagedAgent(event)
  const row = await agentWebhook(cf(event).env, agentId)
  return { webhook: row ? agentWebhookDTO(row) : null }
})
