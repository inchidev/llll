import type { H3Event } from 'h3'
import { Permission, hasPermission } from '../../shared/permissions'
import { requireMember } from './guards'
import { fail } from './cf'
import type { StoredAgentProvider } from './agent-providers'

/**
 * The Owner manages every model provider. A member with Use agents manages
 * only ChatGPT connections of their own plan: creating one, signing in, its
 * models, sharing and removing it. Server API keys stay Owner-only.
 */
export async function providerManager(event: H3Event) {
  const actor = await requireMember(event, getRouterParam(event, 'id')!)
  const member = actor.isOwner || hasPermission(actor.perms, Permission.useAgents)
  if (!member) fail(403, 'forbidden', 'Use agents is required to connect ChatGPT')
  return {
    actor,
    owner: actor.isOwner,
    /** Throws unless this actor may change this connection (or create one of this kind). */
    require(kind: StoredAgentProvider['kind'] | undefined, current: StoredAgentProvider | null) {
      if (actor.isOwner) return
      if ((current?.kind ?? kind) !== 'chatgpt') fail(403, 'forbidden', 'Only the owner can manage Server provider credentials')
      if (current && current.connectedBy && current.connectedBy !== actor.user.id) fail(403, 'forbidden', 'This ChatGPT connection belongs to another member')
    },
  }
}
