import { Temporal } from '@js-temporal/polyfill'
import { z } from 'zod'

export const SCHEDULE_ACTIVE_LIMIT = 50

export function isTimeZone(value: string): boolean {
  try { Temporal.Now.zonedDateTimeISO(value); return true } catch { return false }
}

export const scheduleRequestSchema = z.object({
  channelId: z.string().min(8), kind: z.enum(['reminder', 'work']),
  content: z.string().trim().min(1).max(12000),
  firstAt: z.string().datetime({ offset: true }),
  timezone: z.string().min(1).max(100).refine(isTimeZone, 'Choose a valid IANA timezone'),
  recurrence: z.enum(['once', 'daily', 'weekly']).default('once'),
  agentId: z.string().min(8).optional(), taskId: z.string().min(8).optional(),
}).superRefine((value, context) => {
  if (value.kind === 'reminder' && value.content.length > 1800) context.addIssue({ code: 'custom', message: 'A reminder can contain at most 1800 characters' })
  if (value.kind === 'work' && (!value.agentId || !value.taskId)) context.addIssue({ code: 'custom', message: 'Recurring work needs an assigned agent and task' })
})
export type ScheduleRequest = z.infer<typeof scheduleRequestSchema>
export const scheduleStatusFilters = ['current', 'history', 'active', 'paused', 'blocked', 'completed', 'cancelled'] as const
export type ScheduleStatusFilter = typeof scheduleStatusFilters[number]
export const scheduleListQuerySchema = z.object({
  status: z.enum(scheduleStatusFilters).default('current'),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
})
export const scheduleActionSchema = z.object({ action: z.enum(['pause', 'resume', 'dismiss']) })
const scheduleEditFields = {
  content: z.string().trim().min(1).max(12000).optional(),
  firstAt: z.string().datetime({ offset: true }).optional(),
  timezone: z.string().min(1).max(100).refine(isTimeZone, 'Choose a valid IANA timezone').optional(),
  recurrence: z.enum(['once', 'daily', 'weekly']).optional(),
  agentId: z.string().min(8).optional(), taskId: z.string().min(8).optional(),
}
const changesSomething = (value: object) => Object.entries(value).some(([key, field]) => key !== 'action' && field !== undefined)
/** Omitted fields keep their value. The conversation and kind are fixed; `agentId`/`taskId` apply to recurring work only. */
export const scheduleEditSchema = z.object(scheduleEditFields).strict().refine(changesSomething, 'Choose something to change')
export type ScheduleEdit = z.infer<typeof scheduleEditSchema>
export const schedulePatchSchema = z.discriminatedUnion('action', [scheduleActionSchema,
  z.object({ action: z.literal('edit'), ...scheduleEditFields }).strict().refine(changesSomething, 'Choose something to change')])
export type ScheduleStatus = 'active' | 'paused' | 'completed' | 'cancelled' | 'blocked'
export type Schedule = {
  id: string; principalId: string; createdBy: string; channelId: string; kind: 'reminder' | 'work'; content: string
  agentId: string | null; taskId: string | null; firstAt: string; timezone: string; recurrence: 'once' | 'daily' | 'weekly'
  nextAt: string | null; status: ScheduleStatus; lastError: string | null; lastErrorCode: string | null
  authorizationJson: string; mandateJson: string | null; createdAt: string
}
/** `unavailable`: the viewer can no longer open the conversation, so content is withheld. */
export type PublicSchedule = Omit<Schedule, 'authorizationJson' | 'mandateJson'> & { unavailable?: true }
export const scheduleEditable = (item: Pick<PublicSchedule, 'status'>) => item.status === 'active' || item.status === 'paused' || item.status === 'blocked'
export type ScheduleListPage = { schedules: PublicSchedule[]; nextCursor: string | null; activeCount: number; activeLimit: number }
export type ScheduleOccurrence = {
  dueAt: string; messageId: string | null; runId: string | null; completedAt: string | null
  failedAt: string | null; attempts: number; lastError: string | null
}

/** Skip missed repetitions, preserve the original wall time through DST changes. */
export function nextScheduleAt(schedule: Pick<Schedule, 'firstAt' | 'timezone' | 'recurrence'>, dueAt: string, now: string): string | null {
  if (schedule.recurrence === 'once') return null
  const anchor = Temporal.Instant.from(schedule.firstAt).toZonedDateTimeISO(schedule.timezone)
  let date = Temporal.Instant.from(dueAt).toZonedDateTimeISO(schedule.timezone).toPlainDate()
  for (let count = 0; count < 4000; count++) {
    date = date.add({ days: schedule.recurrence === 'daily' ? 1 : 7 })
    const next = date.toZonedDateTime({ timeZone: schedule.timezone, plainTime: anchor.toPlainTime() }).toInstant()
    if (Temporal.Instant.compare(next, Temporal.Instant.from(now)) > 0) return new Date(Number(next.epochMilliseconds)).toISOString()
  }
  throw new Error('Schedule has been inactive too long')
}

/**
 * Resolve a `datetime-local` value in a zone. A wall time skipped by a DST gap moves forward;
 * one repeated by an overlap uses its first instant. Either is reported so the form can warn.
 */
export function resolveScheduleTime(local: string, timeZone: string): { at: string; wallTime: string; issue: 'gap' | 'overlap' | null } | null {
  if (!local || !isTimeZone(timeZone)) return null
  let plain: Temporal.PlainDateTime
  try { plain = Temporal.PlainDateTime.from(local) } catch { return null }
  const resolved = plain.toZonedDateTime(timeZone, { disambiguation: 'compatible' })
  const later = plain.toZonedDateTime(timeZone, { disambiguation: 'later' })
  const issue = !resolved.toPlainDateTime().equals(plain) ? 'gap' : resolved.epochNanoseconds !== later.epochNanoseconds ? 'overlap' : null
  return { at: resolved.toInstant().toString(), wallTime: resolved.toPlainDateTime().toString({ smallestUnit: 'minute' }), issue }
}

export function formatScheduleTime(iso: string, timeZone?: string, locale?: string): string {
  try { return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone }).format(new Date(iso)) }
  catch { return new Date(iso).toISOString() }
}

export function relativeScheduleTime(iso: string, now = Date.now(), locale?: string): string {
  const seconds = Math.round((Date.parse(iso) - now) / 1000)
  const format = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
  for (const [unit, size] of [['day', 86400], ['hour', 3600], ['minute', 60]] as const) {
    if (Math.abs(seconds) >= size) return format.format(Math.round(seconds / size), unit)
  }
  return format.format(seconds, 'second')
}

/** Recovery guidance for a stored `last_error_code`; the message itself says what happened. */
export function scheduleErrorHint(code: string | null | undefined): string | null {
  switch (code) {
    case 'schedule_revoked': return 'A role or permission this schedule relies on was reduced. Restore it, then resume, or create a new schedule.'
    case 'schedule_denied': return 'The creator no longer has the schedule permissions it needs. Restore them, then resume.'
    case 'channel_unavailable': return 'The conversation was removed or can no longer receive messages from this schedule. Restore access, then resume, or create a new schedule elsewhere.'
    case 'task_reassigned': return 'Assign the task back to the agent, then resume.'
    case 'task_closed': return 'The task is done or archived, so its recurring work stopped. Create a new schedule for open work.'
    case 'agent_unavailable': return 'The agent is paused or removed. Activate it, then resume.'
    case 'pi_unconfigured': return 'Agent execution is not configured on this Server. Ask the Server operator, then resume.'
    case 'agent_task_permission': return 'The agent’s role needs Execute assigned tasks. Change its role, then resume.'
    case 'actor_task_permission': return 'Your role needs Execute assigned tasks. Ask an administrator, then resume.'
    case 'report_access': return 'You and the agent need access and Send messages in the report conversation. Restore access, then resume.'
    case 'model_unavailable': return 'The agent’s model is unavailable. Choose another model for the agent, then resume.'
    case 'project_archived': return 'The task’s project is archived. Restore it, then resume.'
    case 'code_revoked':
    case 'code_denied': return 'The repository environment changed or computer permission was removed. Create a new schedule after reviewing it.'
    case 'run_budget': return 'The daily run budget was reached. Later occurrences run once budget is available.'
    case 'delivery_failed': return 'Delivery failed temporarily and is retried with backoff.'
    default: return null
  }
}
