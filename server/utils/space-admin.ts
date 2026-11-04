import { nowIso } from '../../shared/ids'
import { spaceAdminQuerySchema, type SpaceAdminList, type SpaceAdminRow, type SpaceRole } from '../../shared/spaces'
import type { L4Env } from '../../workers/env'
import { accountEmail } from './account-identity'
import { fail } from './cf'
import type { ServerMembership } from './channel-access'
import { monthlyPeriod } from './space-quota'

/**
 * The Owner's table of Spaces. Counting a Server's Tasks and messages on every load would not last,
 * so the counts come from `space_stats`, a snapshot recomputed in one statement when it is older
 * than this. Only counts: no title, message or filename is read into it or shown from it.
 */
const STATS_MAX_AGE_MS = 5 * 60_000
const NEAR_LIMIT = 0.8
const INACTIVE_MS = 30 * 24 * 60 * 60_000

export function requireSpaceAdmin(member: ServerMembership) {
  if (member.user.kind !== 'human' || member.authorization.credential.kind !== 'session' || !member.isOwner) fail(403, 'forbidden', 'Only the Server Owner can do this')
}

export async function refreshSpaceStats(env: L4Env, now = nowIso()) {
  await env.DB.prepare(`INSERT INTO space_stats (space_id, people, projects, tasks, recordings, storage_bytes, messages, last_activity_at, refreshed_at)
    SELECT s.id, COALESCE(p.n, 0), COALESCE(pr.n, 0), COALESCE(t.n, 0), COALESCE(ta.recordings, 0), COALESCE(ta.bytes, 0) + COALESCE(ca.bytes, 0), COALESCE(m.n, 0),
      NULLIF(MAX(COALESCE(t.last, ''), COALESCE(m.last, '')), ''), ?1
    FROM spaces s
    LEFT JOIN (SELECT sm.space_id, COUNT(*) AS n FROM space_members sm JOIN users u ON u.id = sm.user_id WHERE u.kind = 'human' GROUP BY sm.space_id) p ON p.space_id = s.id
    LEFT JOIN (SELECT space_id, COUNT(*) AS n FROM projects GROUP BY space_id) pr ON pr.space_id = s.id
    LEFT JOIN (SELECT b.space_id, COUNT(*) AS n, MAX(x.updated_at) AS last FROM tasks x JOIN task_boards b ON b.id = x.board_id GROUP BY b.space_id) t ON t.space_id = s.id
    LEFT JOIN (SELECT b.space_id, SUM(a.size_bytes) AS bytes, SUM(a.role = 'recording') AS recordings FROM task_attachments a JOIN tasks x ON x.id = a.task_id JOIN task_boards b ON b.id = x.board_id GROUP BY b.space_id) ta ON ta.space_id = s.id
    LEFT JOIN (SELECT c.space_id, SUM(a.size_bytes) AS bytes FROM attachments a JOIN channels c ON c.id = a.channel_id GROUP BY c.space_id) ca ON ca.space_id = s.id
    LEFT JOIN (SELECT c.space_id, COUNT(*) AS n, MAX(x.created_at) AS last FROM messages x JOIN channels c ON c.id = x.channel_id WHERE x.deleted_at IS NULL GROUP BY c.space_id) m ON m.space_id = s.id
    WHERE true
    ON CONFLICT(space_id) DO UPDATE SET people = excluded.people, projects = excluded.projects, tasks = excluded.tasks, recordings = excluded.recordings,
      storage_bytes = excluded.storage_bytes, messages = excluded.messages, last_activity_at = excluded.last_activity_at, refreshed_at = excluded.refreshed_at`).bind(now).run()
  return now
}

type Row = Omit<SpaceAdminRow, 'isDefault' | 'suspended' | 'creator' | 'quotas' | 'role'> & {
  isDefault: number; suspendedAt: string | null; creatorName: string | null; creatorEmail: string | null; role: SpaceRole | null; storageLimitBytes: number | null
  memberLimit: number | null; agentLimit: number | null; monthlyRunLimit: number | null; monthlyEmailLimit: number | null; monthlyVoiceLimit: number | null
}

export async function listSpacesAdmin(env: L4Env, member: ServerMembership, request: unknown, schedule: (promise: Promise<unknown>) => void): Promise<SpaceAdminList> {
  requireSpaceAdmin(member)
  const query = spaceAdminQuerySchema.parse(request)
  const nowMs = Date.now()
  const last = await env.DB.prepare('SELECT MAX(refreshed_at) AS at FROM space_stats').first<{ at: string | null }>()
  let refreshedAt = last?.at ?? null
  if (!refreshedAt) refreshedAt = await refreshSpaceStats(env)
  else if (nowMs - Date.parse(refreshedAt) > STATS_MAX_AGE_MS) schedule(refreshSpaceStats(env).catch(() => undefined))

  const storage = 'COALESCE(st.storage_bytes, 0)', voice = 'COALESCE(v.count, 0)'
  const sorts: Record<typeof query.sort, string> = {
    name: 'lower(s.name)', creator: "lower(COALESCE(u.display_name, ''))", people: 'COALESCE(st.people, 0)', projects: 'COALESCE(st.projects, 0)', tasks: 'COALESCE(st.tasks, 0)',
    recordings: 'COALESCE(st.recordings, 0)', storage, voice, messages: 'COALESCE(st.messages, 0)', created: 's.created_at', activity: "COALESCE(st.last_activity_at, '')",
  }
  const where: string[] = [], binds: unknown[] = []
  if (query.q) {
    const like = `%${query.q.replace(/[\\%_]/gu, char => `\\${char}`)}%`
    where.push("(s.name LIKE ? ESCAPE '\\' OR u.display_name LIKE ? ESCAPE '\\' OR a.username LIKE ? ESCAPE '\\' OR (a.email_verified = 1 AND a.email LIKE ? ESCAPE '\\'))")
    binds.push(like, like, like, like)
  }
  if (query.limit) {
    const share = query.limit === 'over' ? 1 : NEAR_LIMIT
    where.push(`((s.storage_limit_bytes IS NOT NULL AND ${storage} >= s.storage_limit_bytes * ${share}) OR (s.monthly_voice_limit IS NOT NULL AND ${voice} >= s.monthly_voice_limit * ${share}))`)
  }
  if (query.state === 'suspended') where.push('s.suspended_at IS NOT NULL')
  if (query.state === 'inactive') { where.push('COALESCE(st.last_activity_at, s.created_at) < ?'); binds.push(new Date(nowMs - INACTIVE_MS).toISOString()) }

  const from = `FROM spaces s
    LEFT JOIN space_stats st ON st.space_id = s.id
    LEFT JOIN users u ON u.id = s.created_by
    LEFT JOIN auth_users a ON a.id = s.created_by
    LEFT JOIN space_usage v ON v.space_id = s.id AND v.metric = 'voice' AND v.period = ?
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`
  const period = monthlyPeriod(new Date(nowMs))
  const [rows, counted] = await env.DB.batch([
    env.DB.prepare(`SELECT s.id, s.name, s.description, s.is_default AS isDefault, s.suspended_at AS suspendedAt, s.created_at AS createdAt, u.display_name AS creatorName, a.email AS creatorEmail,
        COALESCE(st.people, 0) AS people, COALESCE(st.projects, 0) AS projects, COALESCE(st.tasks, 0) AS tasks, COALESCE(st.recordings, 0) AS recordings,
        ${storage} AS storageBytes, ${voice} AS voiceMinutes, COALESCE(st.messages, 0) AS messages, st.last_activity_at AS lastActivityAt,
        s.storage_limit_bytes AS storageLimitBytes, s.member_limit AS memberLimit, s.agent_limit AS agentLimit, s.monthly_run_limit AS monthlyRunLimit, s.monthly_email_limit AS monthlyEmailLimit, s.monthly_voice_limit AS monthlyVoiceLimit,
        (SELECT role FROM space_members m WHERE m.space_id = s.id AND m.user_id = ?) AS role
      ${from} ORDER BY ${sorts[query.sort]} ${query.dir === 'asc' ? 'ASC' : 'DESC'}, s.id LIMIT ? OFFSET ?`).bind(member.user.id, period, ...binds, query.pageSize, (query.page - 1) * query.pageSize),
    env.DB.prepare(`SELECT COUNT(*) AS total ${from}`).bind(period, ...binds),
  ])
  return {
    spaces: ((rows?.results ?? []) as Row[]).map(({ isDefault, suspendedAt, creatorName, creatorEmail, storageLimitBytes, memberLimit, agentLimit, monthlyRunLimit, monthlyEmailLimit, monthlyVoiceLimit, ...row }) => ({
      ...row,
      isDefault: Boolean(isDefault),
      suspended: Boolean(suspendedAt),
      memberCount: row.people,
      creator: creatorName ? { name: creatorName, email: creatorEmail && accountEmail({ email: creatorEmail }) } : null,
      quotas: { storageLimitBytes, memberLimit, agentLimit, monthlyRunLimit, monthlyEmailLimit, monthlyVoiceLimit },
    })),
    total: Number((counted?.results?.[0] as { total?: number } | undefined)?.total ?? 0),
    page: query.page,
    pageSize: query.pageSize,
    refreshedAt,
  }
}
