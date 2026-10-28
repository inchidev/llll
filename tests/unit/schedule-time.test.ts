import { describe, expect, it } from 'vitest'
import { formatScheduleTime, relativeScheduleTime, resolveScheduleTime, scheduleErrorHint, scheduleLocalTime, schedulePatchSchema, scheduleRequestSchema } from '../../shared/schedules'

describe('schedule time', () => {
  it('resolves a wall time in the chosen zone and reports DST gaps and overlaps', () => {
    expect(resolveScheduleTime('2026-06-01T09:00', 'Asia/Ho_Chi_Minh')).toEqual({ at: '2026-06-01T02:00:00Z', wallTime: '2026-06-01T09:00', issue: null })
    expect(resolveScheduleTime('2026-03-08T02:30', 'America/New_York')).toEqual({ at: '2026-03-08T07:30:00Z', wallTime: '2026-03-08T03:30', issue: 'gap' })
    expect(resolveScheduleTime('2026-11-01T01:30', 'America/New_York')).toMatchObject({ at: '2026-11-01T05:30:00Z', issue: 'overlap' })
  })
  it('rejects invalid zones and times instead of throwing', () => {
    expect(resolveScheduleTime('2026-06-01T09:00', 'Mars/Olympus')).toBeNull()
    expect(resolveScheduleTime('not a time', 'UTC')).toBeNull()
    expect(scheduleRequestSchema.safeParse({ channelId: 'channel-1', kind: 'reminder', content: 'x', firstAt: '2026-06-01T02:00:00Z', timezone: 'Mars/Olympus' }).success).toBe(false)
  })
  it('formats the next run in the schedule zone, not the viewer zone', () => {
    const at = '2026-06-01T02:00:00Z'
    expect(formatScheduleTime(at, 'Asia/Ho_Chi_Minh', 'en-US').replace(/\s/g, ' ')).toBe('Jun 1, 2026, 9:00 AM')
    expect(formatScheduleTime(at, 'America/Los_Angeles', 'en-US').replace(/\s/g, ' ')).toBe('May 31, 2026, 7:00 PM')
    expect(relativeScheduleTime(at, Date.parse(at) - 3 * 3600000, 'en-US')).toBe('in 3 hours')
    expect(relativeScheduleTime(at, Date.parse(at) + 2 * 86400000, 'en-US')).toBe('2 days ago')
  })
  it('starts an edit from the next run in the schedule zone', () => {
    const daily = { firstAt: '2026-06-01T02:00:00Z', timezone: 'Asia/Ho_Chi_Minh', recurrence: 'daily' as const }
    expect(scheduleLocalTime({ ...daily, nextAt: '2026-06-03T02:00:00Z' }, '2026-06-02T00:00:00Z')).toBe('2026-06-03T09:00')
    expect(scheduleLocalTime({ ...daily, nextAt: '2026-06-03T02:00:00Z' }, '2026-06-05T12:00:00Z')).toBe('2026-06-06T09:00')
    expect(scheduleLocalTime({ ...daily, recurrence: 'once', nextAt: '2026-06-01T02:00:00Z' }, '2026-06-05T12:00:00Z')).toBe('2026-06-01T09:00')
  })
  it('accepts an action or an edit, never a change of conversation or kind', () => {
    expect(schedulePatchSchema.parse({ action: 'pause' })).toEqual({ action: 'pause' })
    expect(schedulePatchSchema.parse({ action: 'edit', content: ' Later ' })).toEqual({ action: 'edit', content: 'Later' })
    expect(schedulePatchSchema.safeParse({ action: 'edit' }).error?.issues[0]?.message).toBe('Choose something to change')
    expect(schedulePatchSchema.safeParse({ action: 'edit', channelId: 'channel-2' }).success).toBe(false)
    expect(schedulePatchSchema.safeParse({ action: 'edit', kind: 'work' }).success).toBe(false)
    expect(schedulePatchSchema.safeParse({ action: 'edit', timezone: 'Mars/Olympus' }).success).toBe(false)
  })
  it('explains how to recover from a blocking reason', () => {
    expect(scheduleErrorHint('task_reassigned')).toMatch(/Assign the task/)
    expect(scheduleErrorHint('channel_unavailable')).toMatch(/conversation/)
    expect(scheduleErrorHint('unknown')).toBeNull()
  })
})
