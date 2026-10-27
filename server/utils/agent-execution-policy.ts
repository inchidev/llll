import { agentExecutionPolicySchema } from '../../shared/agent-execution-policy'
import { readServerSetting } from '../../shared/server-settings'
import type { L4Env } from '../../workers/env'

export const AGENT_EXECUTION_POLICY_KEY = 'agents.executionPolicy'
export async function agentExecutionPolicy(env: Pick<L4Env, 'DB'>) {
  const value = await readServerSetting(env.DB, AGENT_EXECUTION_POLICY_KEY)
  return agentExecutionPolicySchema.parse(value ? JSON.parse(value) : {})
}
