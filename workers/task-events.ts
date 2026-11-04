import { getServerId } from '../shared/server-id'
import type { ServerTasksChangedEvent } from '../shared/server-realtime'
import type { L4Env } from './env'
import { asRpc } from './env'

export async function signalTasksChanged(
  env: L4Env,
  boardId: string | null,
  taskId: string | null = null,
): Promise<void> {
  const event: ServerTasksChangedEvent = { t: 'tasks.changed', boardId, taskId }
  await asRpc<{
    notifyTasksChanged: (event: ServerTasksChangedEvent) => Promise<void>
  }>(env.SERVER_DO.getByName(`server:${(await getServerId(env.DB))}`)).notifyTasksChanged(event)
}
