import type { AgentRun } from '../../shared/agent-execution'
import type { RunPublication } from '../../shared/run-publication'
import type { L4Env } from '../../workers/env'
import { hasPermission, Permission } from '../../shared/permissions'
import { newId, nowIso } from '../../shared/ids'
import { findAgentRun, runAuthorization } from './agent-run-service'
import { requireRunReader } from './agent-tool-security'
import { getTask } from './task-service'
import { fail } from './cf'

type Row = { id: string; runId: string; digest: string; payloadJson: string; status: RunPublication['status']; messageId: string; expiresAt: string; decidedAt: string | null; decidedBy: string | null }
const columns = 'id,run_id AS runId,digest,payload_json AS payloadJson,status,message_id AS messageId,expires_at AS expiresAt,decided_at AS decidedAt,decided_by AS decidedBy'
const AUDIENCE = 'Everyone with access to this conversation, now or in the future. They may copy or forward this text.'
const hash = async (value: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(byte => byte.toString(16).padStart(2, '0')).join('')
async function authorizedRun(env: L4Env, runId: string, actorId: string) {
  const run = await findAgentRun(env, runId)
  if (!run) fail(404, 'not_found', 'Run not found')
  requireRunReader(run, actorId)
  if (run.status !== 'completed' || !run.resultText?.trim() || run.resultText.trim().length > 2000) fail(409, 'publication_unavailable', 'Only completed results of up to 2000 characters can be shared')
  const auth = await runAuthorization(env, run)
  if (!hasPermission(auth.delegation?.permissions ?? 0, Permission.approveAgentActions)) fail(403, 'publication_denied', 'Approve Agent actions is required to share a Run result')
  if (run.taskId && !await getTask(env, auth, run.taskId)) fail(403, 'publication_revoked', 'Task access unavailable')
  return { run, auth }
}
async function payload(env: L4Env, run: AgentRun, auth: Awaited<ReturnType<typeof runAuthorization>>) {
  const channel = await env.DB.prepare('SELECT id,name,type,visibility,parent_id AS parentId FROM channels WHERE id=?').bind(run.channelId).first<{ id: string; name: string; type: string; visibility: string; parentId: string | null }>()
  if (!channel) fail(403, 'publication_revoked', 'Conversation unavailable')
  // No email or externally routed conversation in the first publication slice.
  const mailbox = await env.DB.prepare('SELECT 1 FROM email_mailboxes WHERE channel_id=?').bind(channel.parentId ?? channel.id).first()
  if (mailbox) fail(403, 'publication_unavailable', 'Publishing to an email conversation is unavailable')
  return { action: 'publish_run_result', runId: run.id, agentId: run.agentId, initiatedBy: run.initiatedBy, taskId: run.taskId,
    channel, content: run.resultText!.trim(), audience: AUDIENCE, policy: JSON.stringify(auth), mandate: run.mandateJson }
}
function visible(row: Row): RunPublication {
  const saved = JSON.parse(row.payloadJson) as Awaited<ReturnType<typeof payload>>
  return { id: row.id, digest: row.digest, status: row.status, content: saved.content, channelId: saved.channel.id, channelName: saved.channel.name,
    audience: saved.audience, expiresAt: row.expiresAt, decidedAt: row.decidedAt, decidedBy: row.decidedBy, messageId: row.messageId }
}
export async function runPublication(env: L4Env, runId: string, actorId: string): Promise<RunPublication | null> {
  const run = await findAgentRun(env, runId)
  if (!run) fail(404, 'not_found', 'Run not found')
  requireRunReader(run, actorId)
  await env.DB.prepare("UPDATE agent_run_publications SET status='expired' WHERE run_id=? AND status='pending' AND expires_at<=?").bind(runId, nowIso()).run()
  const row = await env.DB.prepare(`SELECT ${columns} FROM agent_run_publications WHERE run_id=? ORDER BY created_at DESC,id DESC LIMIT 1`).bind(runId).first<Row>()
  return row ? visible(row) : null
}
export async function prepareRunPublication(env: L4Env, runId: string, actorId: string): Promise<RunPublication> {
  const { run, auth } = await authorizedRun(env, runId, actorId)
  const previous = await runPublication(env, runId, actorId)
  if (previous && !['expired', 'rejected'].includes(previous.status)) return previous
  const id = newId(), messageId = newId(), createdAt = nowIso(), expiresAt = new Date(Date.now() + 15 * 60_000).toISOString()
  const encoded = JSON.stringify(await payload(env, run, auth))
  const digest = await hash(JSON.stringify({ id, messageId, expiresAt, payload: encoded }))
  await env.DB.prepare(`INSERT INTO agent_run_publications(id,run_id,digest,payload_json,status,message_id,created_at,expires_at)
    SELECT ?,?,?,?,'pending',?,?,? WHERE (SELECT count(*) FROM agent_run_publications WHERE run_id=?)<5
    ON CONFLICT DO NOTHING`).bind(id, runId, digest, encoded, messageId, createdAt, expiresAt, runId).run()
  const result = await runPublication(env, runId, actorId)
  if (!result || ['expired', 'rejected'].includes(result.status)) fail(429, 'publication_budget', 'Publication review limit reached')
  return result
}
export async function decideRunPublication(env: L4Env, runId: string, actorId: string, request: { id: string; digest: string; decision: 'approve' | 'reject' }, publish: (input: { agentId: string; content: string; sourcePublicationId: string }) => Promise<{ id: string; channelId: string }>): Promise<RunPublication> {
  const { run, auth } = await authorizedRun(env, runId, actorId)
  await runPublication(env, runId, actorId)
  const row = await env.DB.prepare(`SELECT ${columns} FROM agent_run_publications WHERE id=? AND run_id=?`).bind(request.id, runId).first<Row>()
  if (!row || row.digest !== request.digest) fail(409, 'publication_changed', 'Publication review changed; inspect the exact content again')
  if (row.status === 'completed' && request.decision === 'approve') return visible(row)
  if (row.status !== 'pending') fail(409, 'publication_settled', 'This publication is no longer pending; uncertain outcomes must be inspected, never retried')
  if (request.decision === 'approve' && row.payloadJson !== JSON.stringify(await payload(env, run, auth))) fail(409, 'publication_changed', 'The result, conversation or authority changed. Reject this request and review again.')
  const status = request.decision === 'approve' ? 'executing' : 'rejected'
  const claimed = await env.DB.prepare("UPDATE agent_run_publications SET status=?,decided_at=?,decided_by=? WHERE id=? AND status='pending' AND expires_at>? RETURNING id")
    .bind(status, nowIso(), actorId, row.id, nowIso()).first()
  if (!claimed) fail(409, 'publication_settled', 'Publication decision already taken or expired')
  if (status === 'executing') {
    try {
      const sent = await publish({ agentId: run.agentId, content: run.resultText!.trim(), sourcePublicationId: row.id })
      if (sent.id !== row.messageId || sent.channelId !== run.channelId) throw new Error('Publication receipt mismatch')
      await env.DB.prepare("UPDATE agent_run_publications SET status='completed',completed_at=? WHERE id=? AND status='executing'").bind(nowIso(), row.id).run()
    } catch {
      await env.DB.prepare("UPDATE agent_run_publications SET status='uncertain' WHERE id=? AND status='executing'").bind(row.id).run()
      fail(409, 'publication_uncertain', 'Publication outcome is uncertain. Inspect the conversation; this action will not be retried.')
    }
  }
  return (await runPublication(env, runId, actorId))!
}

/** Final check inside the conversation actor, immediately before persistence. */
export async function authorizedPublicationMessage(env: L4Env, channelId: string, input: { sourcePublicationId: string; agentId: string; content: string }): Promise<string> {
  const row = await env.DB.prepare(`SELECT ${columns} FROM agent_run_publications WHERE id=? AND status='executing'`).bind(input.sourcePublicationId).first<Row>()
  if (!row) fail(403, 'publication_revoked', 'Exact publication approval unavailable')
  const saved = JSON.parse(row.payloadJson) as Awaited<ReturnType<typeof payload>>
  const { run, auth } = await authorizedRun(env, row.runId, saved.initiatedBy)
  if (channelId !== run.channelId || input.agentId !== run.agentId || input.content !== saved.content || !row.decidedBy || row.decidedBy !== run.initiatedBy
    || row.payloadJson !== JSON.stringify(await payload(env, run, auth)) || row.expiresAt <= nowIso()) fail(403, 'publication_revoked', 'Exact publication approval no longer matches')
  return row.messageId
}

/** Private review history: no prompt, payload or result is copied into broad audit feeds. */
export async function runPublicationHistory(env: L4Env, runId: string, actorId: string) {
  const run = await findAgentRun(env, runId)
  if (!run) fail(404, 'not_found', 'Run not found')
  requireRunReader(run, actorId)
  const rows = await env.DB.prepare('SELECT id,status,digest,created_at AS createdAt,expires_at AS expiresAt,decided_at AS decidedAt,decided_by AS decidedBy,completed_at AS completedAt FROM agent_run_publications WHERE run_id=? ORDER BY created_at,id LIMIT 5').bind(runId).all<{ id: string; status: RunPublication['status']; digest: string; createdAt: string; expiresAt: string; decidedAt: string | null; decidedBy: string | null; completedAt: string | null }>()
  return rows.results
}
