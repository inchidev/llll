import { fileStorage } from '../../shared/file-storage'
import type { AgentRun } from '../../shared/agent-execution'
import type { L4Env } from '../../workers/env'

/** A shared conversation is a scheduling boundary, never permission to share private model memory. */
export async function compatibleRunHistory(env: L4Env, run: AgentRun): Promise<boolean> {
  const mixed = await env.DB.prepare(`SELECT 1 FROM agent_runs WHERE session_id=? AND id<>? AND
    (initiated_by<>? OR task_id IS NOT ? OR
      CASE WHEN json_valid(mandate_json) THEN json_remove(mandate_json,'$.rootRunId') ELSE mandate_json END <>
      CASE WHEN json_valid(?) THEN json_remove(?,'$.rootRunId') ELSE ? END
      OR environment_json IS NOT ? OR model<>? OR instructions<>?) LIMIT 1`)
    .bind(run.sessionId, run.id, run.initiatedBy, run.taskId, run.mandateJson, run.mandateJson, run.mandateJson, run.environmentJson, run.model, run.instructions).first()
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

/** How much of a Task's earlier conversation a turn without its transcript is told: the latest turns, in order. */
export const TASK_HISTORY = { turns: 12, chars: 24_000, perTurn: 4_000 }

/**
 * A Task's earlier conversation for a turn that starts without its transcript, such as the first turn on the
 * Task's box after talking the idea through without one, whose authority differs so its private context is
 * not restored. Only the asking Member's own turns are told: what they said and what the Agent answered them,
 * which they already read on each Run's page. The latest turns that fit, oldest first; nothing else.
 */
export async function taskHistoryBrief(env: L4Env, run: Pick<AgentRun, 'id' | 'taskId' | 'initiatedBy' | 'agentId'>): Promise<string> {
  if (!run.taskId) return ''
  const rows = (await env.DB.prepare(`SELECT prompt,result_text AS answer FROM agent_runs
    WHERE task_id=? AND initiated_by=? AND agent_id=? AND id<>? AND status='completed' AND result_text IS NOT NULL
    ORDER BY created_at DESC,id DESC LIMIT ?`).bind(run.taskId, run.initiatedBy, run.agentId, run.id, TASK_HISTORY.turns)
    .all<{ prompt: string; answer: string }>()).results
  const turns: string[] = []
  let used = 0
  for (const row of rows) {
    const clip = (text: string) => text.length > TASK_HISTORY.perTurn ? `${text.slice(0, TASK_HISTORY.perTurn)}…` : text
    const turn = `Member: ${clip(row.prompt)}\nYou: ${clip(row.answer)}`
    if (used + turn.length > TASK_HISTORY.chars) break
    turns.unshift(turn)
    used += turn.length
  }
  if (!turns.length) return ''
  return `\nEarlier in this Task, before this turn (your own conversation with the Member who asks now; the Task, its repository and its commits are the record of what was done):\n${turns.join('\n\n')}`
}
