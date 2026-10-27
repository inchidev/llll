import type { AgentRun, RunMandate } from '../../shared/agent-execution'
import type { L4Env } from '../../workers/env'
import { fail } from './cf'

export type ToolEffect = 'control' | 'read' | 'write' | 'external' | 'unknown'
const controls = new Set(['get_current_time', 'search_tools', 'get_tool_details'])
const reads = new Set(['get_delegated_run', 'list_project_agents', 'list_public_project_repositories', 'inspect_public_project_repository', 'list_private_project_repositories', 'inspect_private_project_repository', 'read_private_project_file', 'factory_status', 'factory_workspace', 'factory_feedback', 'list_tasks', 'get_task', 'list_tables', 'list_data', 'get_document', 'read_records', 'list_schedules', 'read_code_tree', 'read_github_repository', 'check_code_proposal'])
const writes = new Set(['delegate_task', 'create_task', 'update_task', 'execute_task', 'create_table', 'create_record', 'update_record', 'create_document', 'update_document', 'create_reminder', 'cancel_schedule', 'publish_code_changes'])
const external = new Set(['read_url', 'search_web', 'read_code_file', 'read_github_issue', 'read_github_pull_request'])
/** Server-owned classification. Remote hints/descriptions and tool-name prefixes never grant authority. */
export function toolEffect(name: string): ToolEffect {
  if (controls.has(name)) return 'control'
  if (reads.has(name)) return 'read'
  if (writes.has(name)) return 'write'
  if (external.has(name) || name.startsWith('mcp_')) return 'external'
  return 'unknown'
}
export type ToolSecurityStatus = { mode: 'role' | 'review'; untrustedContext: boolean; outboundReviewAvailable: false; decisions: Array<{ tool: string; effect: ToolEffect; untrustedContext: boolean; decision: 'allowed' | 'blocked'; reason: string; createdAt: string }> }

/** Context belongs to the Session, including restored transcripts, failed reads, retries and other Runs. */
export async function untrustedContext(env: L4Env, run: AgentRun): Promise<boolean> {
  const session = await env.DB.prepare(`SELECT CASE WHEN untrusted_at IS NOT NULL
    OR (transcript_key IS NOT NULL AND transcript_key<>?)
    OR EXISTS(SELECT 1 FROM agent_runs WHERE session_id=? AND task_id IS NOT NULL)
    OR EXISTS(SELECT 1 FROM agent_run_tools t JOIN agent_runs r ON r.id=t.run_id WHERE r.session_id=? AND t.name NOT IN ('get_current_time','search_tools','get_tool_details'))
    OR EXISTS(SELECT 1 FROM messages WHERE id=? AND author_id<>?) THEN 1 ELSE 0 END AS untrusted FROM agent_sessions WHERE id=?`)
    .bind(`agent-sessions/${run.sessionId}/${run.id}.jsonl`, run.sessionId, run.sessionId, run.sourceMessageId, run.initiatedBy, run.sessionId).first<{ untrusted: number }>()
  return !session || Boolean(session.untrusted)
}
export async function markUntrustedContext(env: L4Env, run: AgentRun) {
  await env.DB.prepare('UPDATE agent_sessions SET untrusted_at=COALESCE(untrusted_at,?) WHERE id=?').bind(new Date().toISOString(), run.sessionId).run()
}
export function toolSecurityReason(name: string, untrusted: boolean, mode: 'role' | 'review' = 'review'): string | null {
  const effect = toolEffect(name)
  if (effect === 'unknown') return 'unclassified_tool'
  // Tool identity is only a gate. The service still checks current principal,
  // delegator, project, resources and the immutable Run scope on every call.
  if (mode === 'role') return null
  if (effect === 'external') return 'exact_outbound_review_unavailable'
  if (effect === 'write') return untrusted ? 'untrusted_context_requires_review' : 'exact_write_review_unavailable'
  return null
}
export async function guardRunTool(env: L4Env, run: AgentRun, name: string, callId?: string) {
  const effect = toolEffect(name)
  const untrusted = await untrustedContext(env, run)
  const mandate = JSON.parse(run.mandateJson) as RunMandate
  const reason = toolSecurityReason(name, untrusted, mandate.execution?.mode)
  // Mark before starting any read: concurrent calls, failed reads and process death cannot clear taint.
  if (!reason && (effect === 'read' || effect === 'external')) await markUntrustedContext(env, run)
  if (callId) await env.DB.prepare(`INSERT INTO agent_tool_decisions(run_id,call_id,tool,effect,untrusted_context,decision,reason,created_at)
    SELECT ?,?,?,?,?,?,?,? WHERE (SELECT count(*) FROM agent_tool_decisions WHERE run_id=?)<?
    ON CONFLICT(run_id,call_id) DO NOTHING`)
    .bind(run.id, callId, effect === 'external' ? 'external_tool' : effect === 'unknown' ? 'unknown_tool' : name, effect, untrusted ? 1 : 0, reason ? 'blocked' : 'allowed', reason ?? 'context_guard_passed', new Date().toISOString(), run.id, mandate.maxToolCalls).run()
  if (reason) fail(403, 'tool_review_required', 'This operation requires exact human review. Sensitive-action approvals are unavailable; no effect was executed.')
}
export async function runToolSecurity(env: L4Env, run: AgentRun): Promise<ToolSecurityStatus> {
  const untrusted = await untrustedContext(env, run)
  const decisions = await env.DB.prepare('SELECT tool,effect,untrusted_context AS untrustedContext,decision,reason,created_at AS createdAt FROM agent_tool_decisions WHERE run_id=? ORDER BY created_at LIMIT 100')
    .bind(run.id).all<Omit<ToolSecurityStatus['decisions'][number], 'untrustedContext'> & { untrustedContext: number }>()
  return { mode: (JSON.parse(run.mandateJson) as RunMandate).execution?.mode ?? 'review', untrustedContext: untrusted, outboundReviewAvailable: false, decisions: decisions.results.map(decision => ({ ...decision, untrustedContext: Boolean(decision.untrustedContext) })) }
}

/** Run payloads and archives are private to the delegating human, even if another Member manages Agents. */
export function requireRunReader(run: Pick<AgentRun, 'initiatedBy'>, memberId: string) {
  if (run.initiatedBy !== memberId) fail(403, 'private_run', 'Run content is private to the initiating Member')
}
export function safeRunProgress(status: string): string {
  return status === 'queued' ? 'Queued' : status === 'tool' ? 'Using a tool' : status === 'waiting_approval' ? 'Review required' : 'Working'
}
export const PRIVATE_RUN_SUMMARY = 'Private result available to the initiating Member.'
export async function runReport(env: L4Env, run: AgentRun): Promise<{ text: string; restricted: boolean }> {
  const mandate = JSON.parse(run.mandateJson) as RunMandate
  // Only conversation and explicitly public repository context may be shared
  // automatically. Other tools can expose data outside this channel's audience.
  if (!run.taskId && run.status === 'completed' && run.resultText && mandate.execution?.mode === 'role') {
    const restricted = await env.DB.prepare(`SELECT 1 WHERE EXISTS(SELECT 1 FROM agent_runs WHERE session_id=? AND task_id IS NOT NULL)
      OR EXISTS(SELECT 1 FROM agent_run_tools t JOIN agent_runs r ON r.id=t.run_id WHERE r.session_id=?
        AND t.name NOT IN ('get_current_time','search_tools','get_tool_details','list_public_project_repositories','inspect_public_project_repository'))`).bind(run.sessionId, run.sessionId).first()
    if (!restricted) return { restricted: false, text: run.resultText.slice(0, 12000) }
    // A two-person DM already has the same audience as the private Run.
    const dm = await env.DB.prepare(`SELECT 1 FROM channels c LEFT JOIN channels parent ON parent.id=c.parent_id
      JOIN channels root ON root.id=CASE WHEN c.type='thread' THEN parent.id ELSE c.id END
      WHERE c.id=? AND root.type='dm'
      AND (SELECT count(*) FROM channel_members WHERE channel_id=root.id)=2
      AND EXISTS(SELECT 1 FROM channel_members WHERE channel_id=root.id AND user_id=?)
      AND EXISTS(SELECT 1 FROM channel_members WHERE channel_id=root.id AND user_id=?)`).bind(run.channelId, run.initiatedBy, run.agentId).first()
    if (dm) {
      const unsafe = await env.DB.prepare(`SELECT 1 WHERE EXISTS(SELECT 1 FROM agent_runs WHERE session_id=? AND task_id IS NOT NULL)
        OR EXISTS(SELECT 1 FROM agent_run_tools t JOIN agent_runs r ON r.id=t.run_id WHERE r.session_id=?
          AND t.name NOT IN ('get_current_time','search_tools','get_tool_details','list_public_project_repositories','inspect_public_project_repository','list_private_project_repositories','inspect_private_project_repository','read_private_project_file'))`).bind(run.sessionId, run.sessionId).first()
      if (!unsafe) return { restricted: false, text: run.resultText.slice(0, 12000) }
    }
  }
  return { restricted: true, text: `Run ${run.status}. ${PRIVATE_RUN_SUMMARY}\n\n[Open private Run](/runs/${run.id})` }
}
