import { factoryCompletion } from './factory-completion'
import { PRIVATE_RUN_SUMMARY } from './agent-tool-security'
import type { AgentRun } from '../../shared/agent-execution'
import { authorize, ServerAction } from '../../shared/authorization'
import { nowIso } from '../../shared/ids'
import type { L4Env } from '../../workers/env'
import { runAuthorization } from './agent-run-service'
import { getTask } from './task-service'
import { signalTasksChanged } from '../../workers/task-events'

export type RunDelivery = {
  taskStatus: 'pending' | 'complete' | 'skipped' | 'blocked'; taskError: string | null
  reportStatus: 'pending' | 'complete' | 'blocked'; reportError: string | null; attempts: number
}
export async function runDelivery(env: L4Env, id: string): Promise<RunDelivery | null> {
  return env.DB.prepare('SELECT task_status as taskStatus,task_error as taskError,report_status as reportStatus,report_error as reportError,attempts FROM agent_run_deliveries WHERE run_id=?').bind(id).first<RunDelivery>()
}
const denied = (error: unknown) => Boolean(error && typeof error === 'object' && 'statusCode' in error && [403, 404].includes(Number(error.statusCode)))

/** Computation and delivery settle independently. Replaying delivery never calls the model. */
export async function deliverAgentRun(env: L4Env, run: AgentRun, publish: () => Promise<void>): Promise<boolean> {
  if (!['completed', 'failed'].includes(run.status)) return true
  await env.DB.prepare("INSERT INTO agent_run_deliveries(run_id,task_status,updated_at) VALUES(?,?,?) ON CONFLICT DO NOTHING")
    .bind(run.id, run.taskId ? 'pending' : 'skipped', nowIso()).run()
  const delivery = (await runDelivery(env, run.id))!
  const attempts = delivery.attempts + 1
  if (delivery.taskStatus === 'pending') {
    try {
      const auth = await runAuthorization(env, run)
      authorize(auth, ServerAction.executeTasks)
      const task = await getTask(env, auth, run.taskId!)
      const factory = await factoryCompletion(env, run)
      const eligible = task?.assigneeId === run.agentId && !task.archivedAt
      const result = eligible ? await env.DB.prepare(`UPDATE tasks SET status=?,result_summary=?,result_details=?,last_error=?,updated_at=?
        WHERE id=? AND assignee_id=? AND archived_at IS NULL
        AND (updated_at<=? OR updated_at=(SELECT task_edit_at FROM agent_runs WHERE id=?))
        AND status NOT IN ('done','review')`)
        .bind(run.status === 'completed' && !factory.pending && !factory.missingWork ? 'review' : 'failed', PRIVATE_RUN_SUMMARY,
          `[Open private Run](/runs/${run.id})`, run.status === 'failed' ? 'Run failed; private details require review.' : null, nowIso(), run.taskId, run.agentId, run.createdAt, run.id).run() : null
      const changed = Boolean(result?.meta.changes)
      await env.DB.prepare('UPDATE agent_run_deliveries SET task_status=?,task_error=?,updated_at=? WHERE run_id=?')
        .bind(changed ? 'complete' : 'skipped', changed ? null : 'The task changed after this Run started; its current state was preserved.', nowIso(), run.id).run()
      if (changed) await signalTasksChanged(env, task!.boardId, task!.id).catch(() => undefined)
    } catch (error) {
      await env.DB.prepare('UPDATE agent_run_deliveries SET task_status=?,task_error=?,updated_at=? WHERE run_id=?')
        .bind(denied(error) || attempts >= 5 ? 'blocked' : 'pending', denied(error)
          ? 'Task result could not be saved: task access or Execute assigned tasks was revoked.'
          : 'Task result could not be saved. Retry delivery; the saved result will be reused.', nowIso(), run.id).run()
    }
  }
  if (delivery.reportStatus === 'pending') {
    try {
      await runAuthorization(env, run)
      await publish()
      await env.DB.prepare("UPDATE agent_run_deliveries SET report_status='complete',report_error=NULL,updated_at=? WHERE run_id=?").bind(nowIso(), run.id).run()
    } catch (error) {
      await env.DB.prepare('UPDATE agent_run_deliveries SET report_status=?,report_error=?,updated_at=? WHERE run_id=?')
        .bind(denied(error) || attempts >= 5 ? 'blocked' : 'pending', denied(error)
          ? 'Report delivery was blocked because conversation access or Send messages was revoked.'
          : 'Report delivery failed. Retry delivery; the saved result will be reused.', nowIso(), run.id).run()
    }
  }
  await env.DB.prepare('UPDATE agent_run_deliveries SET attempts=?,updated_at=? WHERE run_id=?').bind(attempts, nowIso(), run.id).run()
  const settled = (await runDelivery(env, run.id))!
  return settled.taskStatus !== 'pending' && settled.reportStatus !== 'pending'
}
