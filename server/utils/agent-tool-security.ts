import type { AgentRun, RunMandate } from '../../shared/agent-execution'
import type { L4Env } from '../../workers/env'
import { fail } from './cf'

export type ToolEffect = 'control' | 'read' | 'write' | 'external' | 'unknown'
const controls = new Set(['get_current_time', 'search_tools', 'get_tool_details'])
const reads = new Set(['get_delegated_run', 'list_project_agents', 'list_public_project_repositories', 'inspect_public_project_repository', 'list_private_project_repositories', 'inspect_private_project_repository', 'read_private_project_file', 'factory_status', 'factory_workspace', 'factory_feedback', 'list_tasks', 'get_task', 'list_tables', 'list_data', 'get_document', 'read_records', 'list_schedules', 'read_code_tree', 'read_github_repository', 'check_code_proposal'])
const writes = new Set(['delegate_task', 'create_task', 'update_task', 'execute_task', 'create_table', 'create_record', 'update_record', 'create_document', 'update_document', 'create_reminder', 'cancel_schedule', 'publish_code_changes'])
const external = new Set(['read_url', 'search_web', 'read_code_file', 'read_github_issue', 'read_github_pull_request'])
const publicReads = new Set(['list_public_project_repositories', 'inspect_public_project_repository', 'list_project_agents'])
/** Reads of Server data that not every Member or outside party may see. */
export const privateSourceTools = [...reads].filter(name => !publicReads.has(name))
/** Tools whose free-form arguments reach third parties, so they can carry data out. */
export function arbitraryEgress(name: string): boolean {
  return name === 'read_url' || name === 'search_web' || name.startsWith('mcp_')
}
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
/**
 * A Session has private context once it carries Task content or has read a private source.
 * Any of that may contain injected instructions, and none of it may leave through egress.
 */
export async function privateContext(env: L4Env, run: AgentRun): Promise<boolean> {
  const marks = privateSourceTools.map(() => '?').join(',')
  const row = await env.DB.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM agent_runs WHERE session_id=? AND task_id IS NOT NULL)
    OR EXISTS(SELECT 1 FROM agent_run_tools t JOIN agent_runs r ON r.id=t.run_id WHERE r.session_id=? AND t.name IN (${marks})) THEN 1 ELSE 0 END AS private`)
    .bind(run.sessionId, run.sessionId, ...privateSourceTools).first<{ private: number }>()
  return !row || Boolean(row.private)
}
export function toolSecurityReason(name: string, untrusted: boolean, mode: 'role' | 'review' = 'review', privateData = false): string | null {
  const effect = toolEffect(name)
  if (effect === 'unknown') return 'unclassified_tool'
  // Tool identity is only a gate. The service still checks current principal,
  // delegator, project, resources and the immutable Run scope on every call.
  // Role mode runs autonomously, except that private data never meets open egress:
  // that pairing is how an injected instruction would exfiltrate it.
  if (mode === 'role') return privateData && arbitraryEgress(name) ? 'private_context_blocks_egress' : null
  if (effect === 'external') return 'exact_outbound_review_unavailable'
  if (effect === 'write') return untrusted ? 'untrusted_context_requires_review' : 'exact_write_review_unavailable'
  return null
}
export async function guardRunTool(env: L4Env, run: AgentRun, name: string, callId?: string) {
  const effect = toolEffect(name)
  const untrusted = await untrustedContext(env, run)
  const mandate = JSON.parse(run.mandateJson) as RunMandate
  const role = mandate.execution?.mode === 'role'
  const reason = toolSecurityReason(name, untrusted, mandate.execution?.mode, role && arbitraryEgress(name) && await privateContext(env, run))
  // Mark before starting any read: concurrent calls, failed reads and process death cannot clear taint.
  if (!reason && (effect === 'read' || effect === 'external')) await markUntrustedContext(env, run)
  if (callId) await env.DB.prepare(`INSERT INTO agent_tool_decisions(run_id,call_id,tool,effect,untrusted_context,decision,reason,created_at)
    SELECT ?,?,?,?,?,?,?,? WHERE (SELECT count(*) FROM agent_tool_decisions WHERE run_id=?)<?
    ON CONFLICT(run_id,call_id) DO NOTHING`)
    .bind(run.id, callId, effect === 'external' ? 'external_tool' : effect === 'unknown' ? 'unknown_tool' : name, effect, untrusted ? 1 : 0, reason ? 'blocked' : 'allowed', reason ?? 'context_guard_passed', new Date().toISOString(), run.id, mandate.maxToolCalls).run()
  if (reason === 'private_context_blocks_egress') fail(403, 'private_context_egress', 'This Run has read private data, so it cannot send requests to outside services. Start a new conversation for web research; no request was sent.')
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
  // The initiating Member chose this conversation as the destination for the answer. An answer
  // drawn from private sources may only be posted where the initiator is the only human reader.
  if (!run.taskId && run.status === 'completed' && run.resultText && mandate.execution?.mode === 'role'
    && (!await privateContext(env, run) || await initiatorOnlyAudience(env, run))) {
    return { restricted: false, text: run.resultText.slice(0, 12000) }
  }
  return { restricted: true, text: `Run ${run.status}. ${PRIVATE_RUN_SUMMARY}\n\n[Open private Run](/runs/${run.id})` }
}
/** A direct conversation between the initiator and this Agent, including its threads. */
async function initiatorOnlyAudience(env: L4Env, run: AgentRun): Promise<boolean> {
  const row = await env.DB.prepare(`SELECT 1 AS ok FROM channels c JOIN channels root ON root.id=COALESCE(c.parent_id,c.id)
    WHERE c.id=? AND root.type='dm'
    AND NOT EXISTS(SELECT 1 FROM channel_members m WHERE m.channel_id=root.id AND m.user_id NOT IN (?, ?))
    AND EXISTS(SELECT 1 FROM channel_members m WHERE m.channel_id=root.id AND m.user_id=?)`)
    .bind(run.channelId, run.initiatedBy, run.agentId, run.initiatedBy).first<{ ok: number }>()
  return Boolean(row)
}
