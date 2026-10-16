import type { AgentApprovalDTO, AgentTurnDTO } from '../shared/types'
import { nowIso } from '../shared/ids'
import type { L4Env } from './env'

type AgentTurnRow = {
  submissionId: string
  agentId: string
  channelId: string
  sourceMessageId: string
  initiatedBy: string
  status: AgentTurnDTO['status']
  detail: string | null
  draftMessageId: string | null
  approvalJson: string | null
  createdAt: string
  updatedAt: string
}

function parseApproval(value: string | null): AgentApprovalDTO | null {
  if (!value) return null
  try {
    return JSON.parse(value) as AgentApprovalDTO
  }
  catch {
    return null
  }
}

function dto(row: AgentTurnRow): AgentTurnDTO {
  return { ...row, approval: parseApproval(row.approvalJson) }
}

export async function listAgentTurns(env: L4Env, channelId: string, agentId?: string): Promise<AgentTurnDTO[]> {
  const query = agentId
    ? `SELECT submission_id as submissionId, agent_id as agentId, channel_id as channelId,
              source_message_id as sourceMessageId, initiated_by as initiatedBy, status, detail,
              draft_message_id as draftMessageId, approval_json as approvalJson,
              created_at as createdAt, updated_at as updatedAt
       FROM agent_turns WHERE channel_id = ? AND agent_id = ? ORDER BY created_at, submission_id`
    : `SELECT submission_id as submissionId, agent_id as agentId, channel_id as channelId,
              source_message_id as sourceMessageId, initiated_by as initiatedBy, status, detail,
              draft_message_id as draftMessageId, approval_json as approvalJson,
              created_at as createdAt, updated_at as updatedAt
       FROM agent_turns WHERE channel_id = ? ORDER BY created_at, submission_id`
  const rows = await env.DB.prepare(query).bind(channelId, ...(agentId ? [agentId] : [])).all<AgentTurnRow>()
  return (rows.results ?? []).map(dto)
}

export async function putAgentTurn(env: L4Env, input: {
  submissionId: string
  agentId: string
  channelId: string
  sourceMessageId: string
  initiatedBy: string
  requestId?: string | null
  status: AgentTurnDTO['status']
  detail?: string | null
  draftMessageId?: string | null
  approval?: AgentApprovalDTO | null
}): Promise<void> {
  const now = nowIso()
  await env.DB.prepare(
    `INSERT INTO agent_turns
       (submission_id, agent_id, channel_id, source_message_id, initiated_by, request_id, status, detail, draft_message_id, approval_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(submission_id) DO UPDATE SET
       request_id = coalesce(excluded.request_id, agent_turns.request_id),
       status = excluded.status,
       detail = excluded.detail,
       draft_message_id = coalesce(excluded.draft_message_id, agent_turns.draft_message_id),
       approval_json = excluded.approval_json,
       updated_at = excluded.updated_at`,
  ).bind(
    input.submissionId,
    input.agentId,
    input.channelId,
    input.sourceMessageId,
    input.initiatedBy,
    input.requestId ?? null,
    input.status,
    input.detail ?? null,
    input.draftMessageId ?? null,
    input.approval ? JSON.stringify(input.approval) : null,
    now,
    now,
  ).run()
}

export async function patchAgentTurn(env: L4Env, submissionId: string, patch: {
  requestId?: string | null
  status?: AgentTurnDTO['status']
  detail?: string | null
  draftMessageId?: string | null
  approval?: AgentApprovalDTO | null
}): Promise<void> {
  const assignments = ['updated_at = ?']
  const values: unknown[] = [nowIso()]
  if ('requestId' in patch) { assignments.push('request_id = ?'); values.push(patch.requestId ?? null) }
  if ('status' in patch) { assignments.push('status = ?'); values.push(patch.status) }
  if ('detail' in patch) { assignments.push('detail = ?'); values.push(patch.detail ?? null) }
  if ('draftMessageId' in patch) { assignments.push('draft_message_id = ?'); values.push(patch.draftMessageId ?? null) }
  if ('approval' in patch) { assignments.push('approval_json = ?'); values.push(patch.approval ? JSON.stringify(patch.approval) : null) }
  await env.DB.prepare(`UPDATE agent_turns SET ${assignments.join(', ')} WHERE submission_id = ?`)
    .bind(...values, submissionId).run()
}

export async function deleteAgentTurn(env: L4Env, submissionId: string): Promise<void> {
  await env.DB.prepare('DELETE FROM agent_turns WHERE submission_id = ?').bind(submissionId).run()
}

export async function fanoutAgentTurns(env: L4Env, channelId: string, agentId: string): Promise<void> {
  const runs = await listAgentTurns(env, channelId, agentId)
  const channel = env.CHANNEL_DO.getByName(`channel:${channelId}`) as DurableObjectStub & { fanout: (value: unknown) => Promise<void> }
  await channel.fanout({ t: 'agent.state', agentId, runs })
}
