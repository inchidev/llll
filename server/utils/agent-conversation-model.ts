import type { L4Env } from '../../workers/env'
import { readServerSetting } from '../../shared/server-settings'
import { agentEfforts, type AgentEffort } from '../../shared/agent-providers'
/** Threads inherit their parent conversation's selection. */
export async function agentConversationModelKey(env: L4Env, channelId: string): Promise<string> {
  const channel = await env.DB.prepare('SELECT parent_id as parentId FROM channels WHERE id=?').bind(channelId).first<{ parentId: string | null }>()
  return `agents.conversation.${channel?.parentId ?? channelId}.model`
}
export async function agentConversationModel(env: L4Env, channelId: string): Promise<string | null> {
  return readServerSetting(env.DB, await agentConversationModelKey(env, channelId))
}
/** Reasoning effort for a conversation; threads follow their parent like the model. */
export async function agentConversationEffortKey(env: L4Env, channelId: string): Promise<string> {
  return (await agentConversationModelKey(env, channelId)).replace(/\.model$/u, '.effort')
}
export async function agentConversationEffort(env: L4Env, channelId: string): Promise<AgentEffort> {
  const value = await readServerSetting(env.DB, await agentConversationEffortKey(env, channelId))
  return agentEfforts.includes(value as AgentEffort) ? value as AgentEffort : 'auto'
}
