import type { RunStatus } from '../../shared/agent-execution'
import type { L4Env } from '../../workers/env'
import { requireChannelAccessForMember, type ServerMembership } from './channel-access'

export const RUN_LIST_PAGE_SIZE = 25
export const runListStatuses = ['queued', 'running', 'completed', 'failed', 'cancelled'] as const satisfies readonly RunStatus[]

export type RunListItem = {
  id: string; agentId: string; agentName: string; status: RunStatus; channelId: string; taskId: string | null; taskNumber: number | null
  prompt: string; modelCalls: number; totalTokens: number; createdAt: string; updatedAt: string
}
export type RunListPage = { runs: RunListItem[]; nextCursor: string | null; agents: Array<{ id: string; displayName: string }> }

function parseCursor(value: string | null | undefined): { at: string; id: string } | null {
  if (!value) return null
  const separator = value.lastIndexOf('|')
  return separator > 0 ? { at: value.slice(0, separator), id: value.slice(separator + 1) } : null
}

/**
 * The Runs a Member started, newest first. Run content is private to its initiator, so
 * nobody else's Runs are listed, and a Run is hidden once its conversation is no longer accessible.
 */
export async function listOwnRuns(env: L4Env, member: ServerMembership, input: { status?: RunStatus | null; agentId?: string | null; cursor?: string | null } = {}): Promise<RunListPage> {
  const cursor = parseCursor(input.cursor)
  const [rows, agents] = await Promise.all([
    env.DB.prepare(`SELECT r.id, r.agent_id AS agentId, u.display_name AS agentName, r.status, r.channel_id AS channelId, r.task_id AS taskId,
        n.number AS taskNumber, substr(r.prompt, 1, 280) AS prompt, r.model_calls AS modelCalls, r.total_tokens AS totalTokens,
        r.created_at AS createdAt, r.updated_at AS updatedAt
      FROM agent_runs r JOIN users u ON u.id = r.agent_id LEFT JOIN task_numbers n ON n.task_id = r.task_id
      WHERE r.initiated_by = ? AND (? IS NULL OR r.status = ?) AND (? IS NULL OR r.agent_id = ?)
        AND (? IS NULL OR r.created_at < ? OR (r.created_at = ? AND r.id < ?))
      ORDER BY r.created_at DESC, r.id DESC LIMIT ?`)
      .bind(member.user.id, input.status ?? null, input.status ?? null, input.agentId ?? null, input.agentId ?? null,
        cursor?.at ?? null, cursor?.at ?? null, cursor?.at ?? null, cursor?.id ?? null, RUN_LIST_PAGE_SIZE + 1)
      .all<RunListItem>(),
    env.DB.prepare(`SELECT DISTINCT u.id, u.display_name AS displayName FROM agent_runs r JOIN users u ON u.id = r.agent_id
      WHERE r.initiated_by = ? ORDER BY lower(u.display_name) LIMIT 100`).bind(member.user.id).all<{ id: string; displayName: string }>(),
  ])
  const results = rows.results ?? []
  const page = results.slice(0, RUN_LIST_PAGE_SIZE)
  const allowed = new Map<string, boolean>()
  for (const channelId of new Set(page.map(run => run.channelId))) {
    try { await requireChannelAccessForMember(env, member, channelId); allowed.set(channelId, true) }
    catch { allowed.set(channelId, false) }
  }
  const last = page.at(-1)
  return {
    runs: page.filter(run => allowed.get(run.channelId)),
    nextCursor: results.length > RUN_LIST_PAGE_SIZE && last ? `${last.createdAt}|${last.id}` : null,
    agents: agents.results ?? [],
  }
}
