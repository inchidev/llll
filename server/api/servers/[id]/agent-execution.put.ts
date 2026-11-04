import { agentExecutionPolicySchema } from '../../../../shared/agent-execution-policy'
import { writeServerSetting } from '../../../../shared/server-settings'
import { AGENT_EXECUTION_POLICY_KEY } from '../../../utils/agent-execution-policy'
import { requireMember } from '../../../utils/guards'
import { cf, fail } from '../../../utils/cf'
export default defineEventHandler(async event => {
  const actor = await requireMember(event, getRouterParam(event, 'id')!)
  if (!actor.authorization.principal.isOwner || actor.authorization.credential.kind !== 'session') fail(403, 'forbidden', 'Only the signed-in Server owner can change execution settings')
  const policy = agentExecutionPolicySchema.parse(await readBody(event))
  await writeServerSetting(cf(event).env.DB, AGENT_EXECUTION_POLICY_KEY, JSON.stringify(policy))
  return { policy }
})
