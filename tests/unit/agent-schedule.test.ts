import { DatabaseSync } from 'node:sqlite'
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest'
import { INIT_SQL } from '../../server/utils/db'
import { d1 } from '../helpers/sqlite-d1'
import { Permission } from '../../shared/permissions'
import { loadAuthorizationContext } from '../../server/utils/authorization'
import { createSchedule, executeScheduledOccurrence, findSchedule, scheduleAuthorization } from '../../server/utils/schedule-service'
import { sendChannelMessage } from '../../server/utils/message-service'
import { nextScheduleAt } from '../../shared/schedules'
import type { L4Env } from '../../workers/env'

let db: DatabaseSync
let env: L4Env
const wake = vi.fn()
vi.mock('../../server/utils/message-service', () => ({ sendChannelMessage: vi.fn() }))
beforeEach(() => {
  wake.mockReset()
  vi.mocked(sendChannelMessage).mockReset()
  db = new DatabaseSync(':memory:')
  db.exec(INIT_SQL)
  db.exec(`INSERT INTO server_identity(singleton,id) VALUES(1,'00000000-0000-4000-8000-000000000001');
    INSERT INTO roles(id,key,name,permissions_bitmask) VALUES('scheduler','custom:scheduler','Scheduler',${Permission.manageSchedules | Permission.sendMessages});
    INSERT INTO users(id,display_name,status,role_id,joined_at) VALUES('human-user','Human','active','scheduler','2026-10-21'),('owner-user','Owner','active','scheduler','2026-10-21');
    INSERT INTO server(id,name,owner_id) VALUES('00000000-0000-4000-8000-000000000001','Test','owner-user');
    INSERT INTO channels(id,name,type,visibility) VALUES('public-channel','Public','text','server'),('private-channel','Private','text','private');`)
  env = { DB: d1(db), AGENT_SCHEDULE_DO: { getByName: () => ({ wake }) } } as unknown as L4Env
})
afterEach(() => db.close())
const actor = () => loadAuthorizationContext(env, { principalId: 'human-user', credential: { kind: 'session' } })
const input = () => ({ channelId: 'public-channel', kind: 'reminder' as const, content: 'Review evidence', firstAt: new Date(Date.now() + 60000).toISOString(), timezone: 'Asia/Ho_Chi_Minh', recurrence: 'daily' as const })

describe('revocable schedules', () => {
  it('reuses occurrence delivery identity after a crash between sending and committing progress', async () => {
    const schedule = await createSchedule(env, (await actor())!, { ...input(), recurrence: 'once' })
    db.prepare('UPDATE agent_schedules SET next_at=? WHERE id=?').run(new Date(Date.now() - 1000).toISOString(), schedule.id)
    const item = (await findSchedule(env, schedule.id))!
    const delivered = new Set<string>()
    vi.mocked(sendChannelMessage).mockImplementation(async (_env, _member, _channel, _input, _schedule, id) => {
      delivered.add(id!)
      return { message: { id: id! } } as Awaited<ReturnType<typeof sendChannelMessage>>
    })
    const original = env.DB.batch.bind(env.DB)
    env.DB.batch = vi.fn().mockRejectedValueOnce(new Error('Crash after delivery')).mockImplementation(original)
    await expect(executeScheduledOccurrence(env, item, () => {})).rejects.toThrow('Crash after delivery')
    await executeScheduledOccurrence(env, (await findSchedule(env, item.id))!, () => {})
    expect(delivered.size).toBe(1)
    expect((await findSchedule(env, item.id))?.status).toBe('completed')
    expect(db.prepare('SELECT count(*) as count FROM agent_schedule_occurrences').get()).toMatchObject({ count: 1 })
  })
  it('persists a private ceiling, and blocks delivery after a role reduction', async () => {
    const schedule = await createSchedule(env, (await actor())!, input())
    expect(schedule).not.toHaveProperty('authorizationJson')
    expect(wake).toHaveBeenCalledOnce()
    const saved = (await findSchedule(env, schedule.id))!
    db.prepare('UPDATE roles SET permissions_bitmask=? WHERE id=?').run(Permission.manageSchedules | Permission.sendMessages | Permission.writeData, 'scheduler')
    expect((await scheduleAuthorization(env, saved)).principal.permissions & Permission.writeData).toBe(0)
    db.prepare('UPDATE roles SET permissions_bitmask=? WHERE id=?').run(Permission.sendMessages, 'scheduler')
    await expect(scheduleAuthorization(env, saved)).rejects.toMatchObject({ statusCode: 403 })
  })
  it('does not permit reminders in someone else’s private conversation', async () => {
    await expect(createSchedule(env, (await actor())!, { ...input(), channelId: 'private-channel' })).rejects.toMatchObject({ statusCode: 404 })
    expect(db.prepare('SELECT count(*) as count FROM agent_schedules').get()).toMatchObject({ count: 0 })
  })
  it('does not let schedule administration grant autonomous task execution', async () => {
    await expect(createSchedule(env, (await actor())!, { ...input(), kind: 'work', agentId: 'agent-user', taskId: 'task-0001' })).rejects.toMatchObject({ statusCode: 403 })
  })
  it('preserves the original local time through DST gaps and skips missed repetitions', () => {
    const daily = { firstAt: '2026-03-07T07:30:00Z', timezone: 'America/New_York', recurrence: 'daily' as const }
    const gap = nextScheduleAt(daily, daily.firstAt, '2026-03-07T08:00:00Z')!
    expect(gap).toBe('2026-03-08T07:30:00.000Z')
    expect(nextScheduleAt(daily, gap, '2026-03-08T08:00:00Z')).toBe('2026-03-09T06:30:00.000Z')
    expect(nextScheduleAt(daily, daily.firstAt, '2026-03-20T12:00:00Z')).toBe('2026-03-21T06:30:00.000Z')
  })
})
