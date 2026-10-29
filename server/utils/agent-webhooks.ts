import type { AgentRun } from '../../shared/agent-execution'
import { agentWebhookInput, publicWebhookUrl, type AgentWebhookDTO, type AgentWebhookInput, type AgentWebhookPayload } from '../../shared/agent-webhooks'
import { stripAgentImageMarkers } from '../../shared/agent-images'
import { decryptSecret, encryptSecret, type EncryptedSecret } from '../../shared/encrypted-secret'
import { newId, nowIso } from '../../shared/ids'
import { getServerId } from '../../shared/server-id'
import { asRpc, type L4Env } from '../../workers/env'
import type { AuthorizationContext } from '../../shared/authorization'
import { fail } from './cf'

export type AgentWebhook = { agentId: string; url: string; headerName: string; credentialJson: string | null; replyTimeoutMinutes: number; updatedAt: string }
const scope = (agentId: string) => `agent-webhook:${agentId}`

export async function agentWebhook(env: L4Env, agentId: string): Promise<AgentWebhook | null> {
  return env.DB.prepare(`SELECT agent_id AS agentId,url,header_name AS headerName,credential_json AS credentialJson,
    reply_timeout_minutes AS replyTimeoutMinutes,updated_at AS updatedAt FROM agent_webhooks WHERE agent_id=?`).bind(agentId).first<AgentWebhook>()
}

export function agentWebhookDTO(row: AgentWebhook): AgentWebhookDTO {
  return { url: row.url, headerName: row.headerName, hasHeaderValue: Boolean(row.credentialJson), replyTimeoutMinutes: row.replyTimeoutMinutes, updatedAt: row.updatedAt }
}

export async function saveAgentWebhook(env: L4Env, agentId: string, actorId: string, raw: AgentWebhookInput): Promise<AgentWebhookDTO> {
  const input = agentWebhookInput.parse(raw)
  const current = await agentWebhook(env, agentId)
  // A saved sender key belongs to its destination; it never follows the Agent to a new URL.
  if (current?.credentialJson && !input.headerValue && (current.url !== input.url || current.headerName !== input.headerName)) {
    fail(400, 'webhook_key_required', 'Enter the sender key again for the new URL or header')
  }
  if (input.headerValue && (!env.AUTH_SECRET || env.AUTH_SECRET.length < 32)) fail(409, 'secret_unavailable', 'The Server cannot store secrets until AUTH_SECRET is configured')
  const credentialJson = input.headerValue
    ? JSON.stringify(await encryptSecret(env.AUTH_SECRET!, scope(agentId), input.headerValue))
    : current?.credentialJson ?? null
  const now = nowIso()
  await env.DB.prepare(`INSERT INTO agent_webhooks(agent_id,url,header_name,credential_json,reply_timeout_minutes,created_by,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(agent_id) DO UPDATE SET url=excluded.url,header_name=excluded.header_name,
    credential_json=excluded.credential_json,reply_timeout_minutes=excluded.reply_timeout_minutes,updated_at=excluded.updated_at`)
    .bind(agentId, input.url, input.headerName, credentialJson, input.replyTimeoutMinutes, actorId, now, now).run()
  return agentWebhookDTO((await agentWebhook(env, agentId))!)
}

export async function deleteAgentWebhook(env: L4Env, agentId: string): Promise<boolean> {
  const result = await env.DB.prepare('DELETE FROM agent_webhooks WHERE agent_id=?').bind(agentId).run()
  return Boolean(result.meta.changes)
}

export async function agentWebhookPayload(env: L4Env, run: AgentRun): Promise<AgentWebhookPayload> {
  const names = await env.DB.prepare('SELECT id,display_name AS name FROM users WHERE id IN (?,?)').bind(run.agentId, run.initiatedBy).all<{ id: string; name: string }>()
  const name = (id: string) => names.results.find(row => row.id === id)?.name ?? ''
  const origin = env.PUBLIC_ORIGIN ? new URL(env.PUBLIC_ORIGIN).origin : null
  return {
    type: 'agent.run', version: 1, runId: run.id, deadline: run.deadline,
    server: { id: await getServerId(env.DB), origin, mcp: origin ? `${origin}/mcp` : null },
    agent: { id: run.agentId, name: name(run.agentId) }, from: { id: run.initiatedBy, name: name(run.initiatedBy) },
    conversation: { channelId: run.channelId, sourceMessageId: run.sourceMessageId, taskId: run.taskId },
    prompt: stripAgentImageMarkers(run.prompt).trim(),
    reply: { tool: 'send_message', arguments: { channelId: run.channelId } },
    complete: { tool: 'complete_run', arguments: { runId: run.id } },
  }
}

export type WebhookOutcome = { kind: 'sent' } | { kind: 'retry'; status: number | null } | { kind: 'rejected'; status: number }

/** One wake-up request. Redirects are not followed: the sender key goes only to the saved URL. */
export async function sendAgentWebhook(env: L4Env, hook: AgentWebhook, payload: AgentWebhookPayload): Promise<WebhookOutcome> {
  if (!publicWebhookUrl(hook.url)) return { kind: 'rejected', status: 0 }
  const headers = new Headers({ 'Content-Type': 'application/json', 'Idempotency-Key': payload.runId, 'User-Agent': 'L4-Agent-Webhook/1' })
  if (hook.credentialJson) headers.set(hook.headerName, await decryptSecret(env.AUTH_SECRET!, scope(hook.agentId), JSON.parse(hook.credentialJson) as EncryptedSecret))
  try {
    const response = await fetch(hook.url, { method: 'POST', headers, body: JSON.stringify(payload), redirect: 'manual', signal: AbortSignal.timeout(15000) })
    await response.body?.cancel()
    if (response.ok) return { kind: 'sent' }
    if (response.status === 408 || response.status === 429 || response.status >= 500) return { kind: 'retry', status: response.status }
    return { kind: 'rejected', status: response.status }
  } catch {
    return { kind: 'retry', status: null }
  }
}

/** The external Agent's latest own message in the Run's conversation since the given time. */
export async function externalAgentReply(env: L4Env, run: Pick<AgentRun, 'agentId' | 'channelId'>, since: string): Promise<{ id: string; content: string } | null> {
  return env.DB.prepare(`SELECT id,content FROM messages WHERE channel_id=? AND author_id=? AND deleted_at IS NULL AND created_at>=?
    ORDER BY created_at DESC,id DESC LIMIT 1`).bind(run.channelId, run.agentId, since).first<{ id: string; content: string }>()
}

/**
 * The external Agent says it is done. Intermediate messages never close a Run; this does,
 * and only for the Agent's own running Run. A completed Run needs a reply in its conversation.
 */
export async function completeExternalRun(env: L4Env, actor: AuthorizationContext, input: { runId: string; outcome: 'completed' | 'failed'; note?: string }) {
  const run = await env.DB.prepare(`SELECT r.id,r.agent_id AS agentId,r.channel_id AS channelId,r.status,r.created_at AS createdAt FROM agent_runs r
    JOIN agent_webhooks w ON w.agent_id=r.agent_id WHERE r.id=?`).bind(input.runId).first<{ id: string; agentId: string; channelId: string; status: string; createdAt: string }>()
  if (!run || actor.principal.kind !== 'agent' || run.agentId !== actor.principal.id) fail(404, 'not_found', 'Run not found')
  if (run.status !== 'running') return { runId: run.id, status: run.status, changed: false }
  const reply = await externalAgentReply(env, run, run.createdAt)
  if (input.outcome === 'completed' && !reply) fail(409, 'reply_required', 'Answer with send_message in the Run\'s conversation first, then complete the Run')
  const now = nowIso()
  const changed = input.outcome === 'completed'
    ? await env.DB.prepare("UPDATE agent_runs SET status='completed',result_text=?,result_message_id=?,last_error=NULL,updated_at=? WHERE id=? AND status='running' RETURNING id")
      .bind(input.note?.trim() || reply!.content, reply!.id, now, run.id).first()
    : await env.DB.prepare("UPDATE agent_runs SET status='failed',last_error=?,result_message_id=?,updated_at=? WHERE id=? AND status='running' RETURNING id")
      .bind(input.note?.trim() || 'The Agent reported that it could not finish.', newId(), now, run.id).first()
  // The Run's coordinator settles delivery and releases the conversation queue.
  if (changed && env.AGENT_RUN_DO) await asRpc<{ wake: (id: string) => Promise<void> }>(env.AGENT_RUN_DO.getByName(`run:${run.id}`)).wake(run.id)
  return { runId: run.id, status: input.outcome, changed: Boolean(changed) }
}
