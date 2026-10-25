import { fileStorage } from '../../shared/file-storage'
import type { AgentRun } from '../../shared/agent-execution'
import type { L4Env } from '../../workers/env'

/** A shared conversation is a scheduling boundary, never permission to share private model memory. */
export async function compatibleRunHistory(env: L4Env, run: AgentRun): Promise<boolean> {
  const mixed = await env.DB.prepare(`SELECT 1 FROM agent_runs WHERE session_id=? AND id<>? AND
    (initiated_by<>? OR task_id IS NOT ? OR mandate_json<>? OR environment_json IS NOT ? OR model<>? OR instructions<>?) LIMIT 1`)
    .bind(run.sessionId, run.id, run.initiatedBy, run.taskId, run.mandateJson, run.environmentJson, run.model, run.instructions).first()
  return !mixed
}

/** Unknown, mixed, changed or noncanonical history starts clean; it never falls back to someone else's archive. */
export async function previousRunTranscript(env: L4Env, run: AgentRun): Promise<string | null> {
  if (!await compatibleRunHistory(env, run)) return null
  const source = await env.DB.prepare(`SELECT s.transcript_key AS transcriptKey FROM agent_sessions s JOIN agent_runs r ON r.session_id=s.id
    WHERE s.id=? AND r.id<>? AND r.status='completed' AND r.initiated_by=? AND s.transcript_key='agent-sessions/'||r.session_id||'/'||r.id||'.jsonl' LIMIT 1`)
    .bind(run.sessionId, run.id, run.initiatedBy).first<{ transcriptKey: string }>()
  if (!source) return null
  const object = await fileStorage(env).get(source.transcriptKey)
  if (!object || object.size > 2_000_000) throw new Error('Saved private context is unavailable')
  return object.text()
}
