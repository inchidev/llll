import type { WorkspaceMembersChangedEvent } from '../shared/workspace-realtime'
import type { L4Env } from './env'
import { asRpc } from './env'

export async function signalMembersChanged(env: L4Env, workspaceId: string): Promise<void> {
  const event: WorkspaceMembersChangedEvent = { t: 'members.changed', workspaceId }
  const stub = asRpc<{
    notifyMembersChanged: (event: WorkspaceMembersChangedEvent) => Promise<void>
  }>(env.WORKSPACE_DO.getByName(`workspace:${workspaceId}`))
  await stub.notifyMembersChanged(event)
}
