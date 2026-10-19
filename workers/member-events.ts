import type { ServerMembersChangedEvent } from '../shared/server-realtime'
import type { L4Env } from './env'
import { asRpc } from './env'

export async function signalMembersChanged(env: L4Env, serverId: string): Promise<void> {
  const event: ServerMembersChangedEvent = { t: 'members.changed', serverId }
  const stub = asRpc<{
    notifyMembersChanged: (event: ServerMembersChangedEvent) => Promise<void>
  }>(env.SERVER_DO.getByName(`server:${serverId}`))
  await stub.notifyMembersChanged(event)
}
