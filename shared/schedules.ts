import { Temporal } from '@js-temporal/polyfill'
import { z } from 'zod'

export const scheduleRequestSchema = z.object({
  channelId: z.string().min(8), kind: z.enum(['reminder', 'work']),
  content: z.string().trim().min(1).max(12000),
  firstAt: z.string().datetime({ offset: true }),
  timezone: z.string().min(1).max(100).refine(value => {
    try { Temporal.Now.zonedDateTimeISO(value); return true } catch { return false }
  }, 'Choose a valid IANA timezone'),
  recurrence: z.enum(['once', 'daily', 'weekly']).default('once'),
  agentId: z.string().min(8).optional(), taskId: z.string().min(8).optional(),
}).superRefine((value, context) => {
  if (value.kind === 'reminder' && value.content.length > 1800) context.addIssue({ code: 'custom', message: 'A reminder can contain at most 1800 characters' })
  if (value.kind === 'work' && (!value.agentId || !value.taskId)) context.addIssue({ code: 'custom', message: 'Recurring work needs an assigned agent and task' })
})
export type ScheduleRequest = z.infer<typeof scheduleRequestSchema>
export type Schedule = {
  id: string; principalId: string; createdBy: string; channelId: string; kind: 'reminder' | 'work'; content: string
  agentId: string | null; taskId: string | null; firstAt: string; timezone: string; recurrence: 'once' | 'daily' | 'weekly'
  nextAt: string | null; status: 'active' | 'completed' | 'cancelled' | 'blocked'; lastError: string | null
  authorizationJson: string; mandateJson: string | null; createdAt: string
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
