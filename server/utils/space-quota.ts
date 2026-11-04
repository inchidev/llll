import type { L4Env } from '../../workers/env'
import { fail } from './cf'

export type SpaceMonthlyMetric = 'runs' | 'emails' | 'voice'
const MONTHLY_LIMIT_COLUMN: Record<SpaceMonthlyMetric, string> = { runs: 'monthly_run_limit', emails: 'monthly_email_limit', voice: 'monthly_voice_limit' }
const STORAGE_SQL = `SELECT COALESCE((SELECT SUM(a.size_bytes) FROM attachments a JOIN channels c ON c.id = a.channel_id WHERE c.space_id = ?1), 0)
  + COALESCE((SELECT SUM(a.size_bytes) FROM task_attachments a JOIN tasks t ON t.id = a.task_id JOIN task_boards b ON b.id = t.board_id WHERE b.space_id = ?1), 0) AS bytes`

function quotaExceeded(message: string): never {
  fail(429, 'space_quota', message)
}
export function monthlyPeriod(now = new Date()): string {
  return now.toISOString().slice(0, 7)
}

/**
 * Counts one use against the month's limit, atomically: concurrent Runs cannot pass a hard limit
 * together. The count always moves, so turning a limit on later starts from what was really used.
 */
export async function consumeSpaceQuota(env: L4Env, spaceId: string, metric: SpaceMonthlyMetric, label: string, message?: string): Promise<void> {
  const period = monthlyPeriod()
  const counted = await env.DB.prepare(`INSERT INTO space_usage(space_id, metric, period, count)
    SELECT ?1, ?2, ?3, 1 WHERE (SELECT ${MONTHLY_LIMIT_COLUMN[metric]} FROM spaces WHERE id = ?1) IS NULL
      OR (SELECT ${MONTHLY_LIMIT_COLUMN[metric]} FROM spaces WHERE id = ?1) > COALESCE((SELECT count FROM space_usage WHERE space_id = ?1 AND metric = ?2 AND period = ?3), 0)
    ON CONFLICT(space_id, metric, period) DO UPDATE SET count = count + 1 RETURNING count`).bind(spaceId, metric, period).first()
  if (!counted) quotaExceeded(message ?? `This Space has used its ${label} for the month`)
}

/**
 * Counts one chunk of voice against its Space's month, before any AI is spent. Only transcribing is
 * refused at the limit: a recording uploads the same. Without a chosen Space there is nowhere to count it.
 */
export async function requireVoiceQuota(env: L4Env, spaceId: string | null) {
  if (!spaceId) return
  await consumeSpaceQuota(env, spaceId, 'voice', 'voice transcription', 'This Space has used its voice transcription for the month. Recording still works: type what you said.')
}

/** Refuses an upload past the Space's storage limit. Only a limited Space pays for the sum. */
export async function requireStorageQuota(env: L4Env, spaceId: string, bytes: number): Promise<void> {
  const space = await env.DB.prepare('SELECT storage_limit_bytes AS limit_bytes FROM spaces WHERE id = ?').bind(spaceId).first<{ limit_bytes: number | null }>()
  if (space?.limit_bytes == null) return
  const used = await env.DB.prepare(STORAGE_SQL).bind(spaceId).first<{ bytes: number }>()
  if ((used?.bytes ?? 0) + bytes > space.limit_bytes) quotaExceeded('This Space has used its file storage')
}

/** Refuses a new person or Agent past the Space's limit. */
export async function requireMemberQuota(env: L4Env, spaceId: string, kind: 'human' | 'agent'): Promise<void> {
  const row = await env.DB.prepare(`SELECT s.${kind === 'human' ? 'member_limit' : 'agent_limit'} AS seats,
      (SELECT COUNT(*) FROM space_members m JOIN users u ON u.id = m.user_id WHERE m.space_id = s.id AND u.kind = ?2) AS used
    FROM spaces s WHERE s.id = ?1`).bind(spaceId, kind).first<{ seats: number | null; used: number }>()
  if (row?.seats != null && row.used >= row.seats) quotaExceeded(kind === 'human' ? 'This Space has reached its limit of people' : 'This Space has reached its limit of Agents')
}

export async function spaceUsage(env: L4Env, spaceId: string) {
  const period = monthlyPeriod()
  const [storage, members, monthly] = await Promise.all([
    env.DB.prepare(STORAGE_SQL).bind(spaceId).first<{ bytes: number }>(),
    env.DB.prepare(`SELECT SUM(u.kind = 'human') AS members, SUM(u.kind = 'agent') AS agents FROM space_members m JOIN users u ON u.id = m.user_id WHERE m.space_id = ?`).bind(spaceId).first<{ members: number | null; agents: number | null }>(),
    env.DB.prepare('SELECT metric, count FROM space_usage WHERE space_id = ? AND period = ?').bind(spaceId, period).all<{ metric: SpaceMonthlyMetric; count: number }>(),
  ])
  const count = (metric: SpaceMonthlyMetric) => monthly.results?.find(row => row.metric === metric)?.count ?? 0
  return { storageBytes: storage?.bytes ?? 0, members: members?.members ?? 0, agents: members?.agents ?? 0, runs: count('runs'), emails: count('emails'), voice: count('voice') }
}
