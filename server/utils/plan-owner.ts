import type { H3Event } from 'h3'
import { fail } from './cf'
import { requireMember } from './guards'

/** The plan is the Owner's, in a session: no Member, Agent or MCP token can read or change it. */
export async function requirePlanOwner(event: H3Event) {
  const member = await requireMember(event, getRouterParam(event, 'id')!)
  if (!member.isOwner || member.user.kind !== 'human' || member.authorization.credential.kind !== 'session') fail(403, 'forbidden', 'Only the Server Owner can manage the plan')
  return member
}
