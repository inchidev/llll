import { and, eq } from 'drizzle-orm'
import { agents, roles, users } from '../../../../../drizzle/schema'
import { nowIso } from '../../../../../shared/ids'
import { Permission } from '../../../../../shared/permissions'
import { requireMember } from '../../../../utils/guards'
import { asRpc, cf, fail, requireFiles } from '../../../../utils/cf'
import { getDb } from '../../../../utils/db'
import { writeAudit } from '../../../../utils/messages'
import { assertRoleManageable } from '../../../../utils/role-policy'
import { revalidateLiveRooms } from '../../../../utils/live'
import { signalMembersChanged } from '../../../../../workers/member-events'
import { signalTasksChanged } from '../../../../../workers/task-events'

/**
 * Deletes an Agent for new work while keeping its history. The Member row is
 * removed like a kicked Member and the profile is marked archived, so messages,
 * Runs, Task results and audit entries still resolve. Everything that could
 * start new work as the Agent is stopped here rather than left to fail later.
 */
export default defineEventHandler(async (event) => {
  const serverId = getRouterParam(event, 'id')!
  const agentId = getRouterParam(event, 'agentId')!
  const actor = await requireMember(event, serverId, Permission.manageAgents)
  const { env, waitUntil } = cf(event)
  const db = getDb(env.DB)
  const current = (await db.select({ user: users, role: roles }).from(agents)
    .innerJoin(users, eq(users.id, agents.userId))
    .innerJoin(roles, eq(roles.id, users.roleId))
    .where(and(eq(agents.userId, agentId), eq(users.status, 'active'), eq(users.kind, 'agent')))
    .limit(1))[0]
  if (!current) fail(404, 'not_found', 'Agent not found')
  // The same hierarchy as editing the Agent: a weaker manager cannot remove a stronger Agent.
  assertRoleManageable(actor, current.role)

  const now = nowIso()
  const activeRuns = await env.DB.prepare("SELECT id FROM agent_runs WHERE agent_id=? AND status IN ('queued','running')")
    .bind(agentId).all<{ id: string }>()
  const openTasks = await env.DB.prepare("SELECT id, board_id AS boardId FROM tasks WHERE assignee_id=? AND status NOT IN ('done') AND archived_at IS NULL")
    .bind(agentId).all<{ id: string; boardId: string }>()
  const [, , schedules, connections, tokens] = await env.DB.batch([
    env.DB.prepare(`UPDATE users SET status='removed', role_id=NULL, nickname=NULL, joined_at=NULL, avatar_r2_key=NULL, updated_at=? WHERE id=?`).bind(now, agentId),
    env.DB.prepare(`UPDATE agents SET status='paused', archived_at=?, archived_by=?, updated_at=? WHERE user_id=?`).bind(now, actor.user.id, now, agentId),
    env.DB.prepare(`UPDATE agent_schedules SET status='cancelled', next_at=NULL WHERE status='active' AND (principal_id=? OR agent_id=?)`).bind(agentId, agentId),
    env.DB.prepare('UPDATE mcp_oauth_connections SET revoked_at=? WHERE subject_id=? AND revoked_at IS NULL').bind(now, agentId),
    env.DB.prepare('UPDATE mcp_access_tokens SET revoked_at=?, updated_at=? WHERE subject_id=? AND revoked_at IS NULL').bind(now, now, agentId),
    // Completed Tasks keep the Agent as their assignee for history; open ones need a new owner.
    env.DB.prepare(`UPDATE tasks SET assignee_id=NULL, status=CASE WHEN status='ready' THEN 'backlog' ELSE status END, updated_at=?
      WHERE assignee_id=? AND status NOT IN ('done') AND archived_at IS NULL`).bind(now, agentId),
    // Its sender key and destination are useless without the Agent and must not linger.
    env.DB.prepare('DELETE FROM agent_webhooks WHERE agent_id=?').bind(agentId),
  ])

  // Runs end through their own Durable Object so their status, budget and report settle normally.
  // The runtime also rechecks the Agent's membership on every step, so a missed cancel cannot continue work.
  let cancelledRuns = 0
  for (const run of activeRuns.results ?? []) {
    try {
      if (env.AGENT_RUN_DO) await asRpc<{ cancel: () => Promise<void> }>(env.AGENT_RUN_DO.getByName(`run:${run.id}`)).cancel()
      cancelledRuns += 1
    }
    catch { /* Revocation above already fences this Run. */ }
  }
  if (current.user.avatarR2Key) {
    try { await requireFiles(env).delete(current.user.avatarR2Key) }
    catch { /* The profile no longer references it; storage cleanup can be retried by an operator. */ }
  }
  await writeAudit(env, {
    serverId,
    actorId: actor.user.id,
    action: 'agent.delete',
    targetType: 'agent',
    targetId: agentId,
    meta: {
      displayName: current.user.displayName,
      roleId: current.user.roleId,
      cancelledRuns,
      cancelledSchedules: schedules?.meta?.changes ?? 0,
      revokedConnections: (connections?.meta?.changes ?? 0) + (tokens?.meta?.changes ?? 0),
      unassignedTasks: openTasks.results?.length ?? 0,
    },
  })
  waitUntil(signalMembersChanged(env, serverId))
  waitUntil(revalidateLiveRooms(env))
  for (const boardId of new Set((openTasks.results ?? []).map(task => task.boardId))) waitUntil(signalTasksChanged(env, boardId))
  return { ok: true, cancelledRuns, unassignedTasks: openTasks.results?.length ?? 0 }
})
