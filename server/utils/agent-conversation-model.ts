import type { L4Env } from '../../workers/env'
import { readServerSetting } from '../../shared/server-settings'
/** Threads inherit their parent conversation's selection. */
export async function agentConversationModelKey(env: L4Env, channelId: string): Promise<string> {
  const channel = await env.DB.prepare('SELECT parent_id as parentId FROM channels WHERE id=?').bind(channelId).first<{ parentId: string | null }>()
  return `agents.conversation.${channel?.parentId ?? channelId}.model`
}
export async function agentConversationModel(env: L4Env, channelId: string): Promise<string | null> {
  return readServerSetting(env.DB, await agentConversationModelKey(env, channelId))
}
