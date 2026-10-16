import type { WorkspaceTasksChangedEvent } from '../shared/workspace-realtime'
import { WORKSPACE_ID } from '../shared/ids'
import type { L4Env } from './env'
import { asRpc } from './env'

export async function signalTasksChanged(
  env: L4Env,
  boardId: string | null,
  taskId: string | null = null,
): Promise<void> {
  const event: WorkspaceTasksChangedEvent = { t: 'tasks.changed', boardId, taskId }
  const stub = asRpc<{
    notifyTasksChanged: (event: WorkspaceTasksChangedEvent) => Promise<void>
  }>(env.WORKSPACE_DO.getByName(`workspace:${WORKSPACE_ID}`))
  await stub.notifyTasksChanged(event)
}
