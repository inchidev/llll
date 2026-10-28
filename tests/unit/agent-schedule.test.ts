import { DatabaseSync } from 'node:sqlite'
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest'
import { INIT_SQL } from '../../server/utils/db'
import { d1 } from '../helpers/sqlite-d1'
import { Permission } from '../../shared/permissions'
import { loadAuthorizationContext } from '../../server/utils/authorization'
import { cancelSchedule, createSchedule, dismissSchedule, executeScheduledOccurrence, findSchedule, listScheduleOccurrences, listSchedules, pauseSchedule,
  recordScheduleFailure, resumeSchedule, scheduleAuthorization, SCHEDULE_RETRY_DELAYS, updateSchedule } from '../../server/utils/schedule-service'
import { sendChannelMessage } from '../../server/utils/message-service'
import { piConfigured } from '../../server/utils/agent-run-service'
import { nextScheduleAt } from '../../shared/schedules'
import { createError } from 'h3'
import type { L4Env } from '../../workers/env'
import { AgentScheduleDurableObject } from '../../workers/agent-schedule-do'

let db: DatabaseSync
let env: L4Env
const wake = vi.fn()
vi.mock('../../server/utils/message-service', () => ({ sendChannelMessage: vi.fn() }))
vi.mock('../../server/utils/agent-run-service', async original => ({ ...await original<object>(), piConfigured: vi.fn(async () => false) }))
vi.mock('cloudflare:workers', () => ({ DurableObject: class { constructor(protected ctx: unknown, protected env: unknown) {} } }))
beforeEach(() => {
  wake.mockReset()
  vi.mocked(sendChannelMessage).mockReset()
  vi.mocked(piConfigured).mockResolvedValue(false)
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

const typed = (status: number, code: string, message = code) => createError({ statusCode: status, statusMessage: message, data: { error: { code, message } } })
async function due(id: string, at = new Date(Date.now() - 1000).toISOString()) {
  db.prepare('UPDATE agent_schedules SET next_at=? WHERE id=?').run(at, id)
  return (await findSchedule(env, id))!
}
async function reminder(extra: Partial<ReturnType<typeof input>> = {}) {
  return createSchedule(env, (await actor())!, { ...input(), ...extra })
}
async function insertWork(taskStatus = 'ready', assignee: string | null = 'agent-user') {
  db.exec(`INSERT INTO users(id,kind,display_name,status,role_id,joined_at) VALUES('agent-user','agent','Agent','active','scheduler','2026-10-21');
    INSERT INTO agents(user_id,created_by) VALUES('agent-user','owner-user');
    INSERT INTO task_boards(id,name,created_by) VALUES('board-1','Board','owner-user');`)
  db.prepare("INSERT INTO tasks(id,board_id,title,status,assignee_id,created_by) VALUES('task-0001','board-1','Task',?,?,'owner-user')").run(taskStatus, assignee)
  db.prepare(`INSERT INTO agent_schedules(id,principal_id,created_by,channel_id,kind,content,agent_id,task_id,first_at,timezone,recurrence,next_at,status,authorization_json,mandate_json,created_at)
    VALUES('work-1','human-user','human-user','public-channel','work','Do it','agent-user','task-0001',?,'UTC','daily',?,'active',?,'{}',?)`)
    .run('2026-10-01T09:00:00.000Z', new Date(Date.now() - 1000).toISOString(), JSON.stringify(await actor()), new Date().toISOString())
  return (await findSchedule(env, 'work-1'))!
}
const occurrence = (id: string) => db.prepare('SELECT attempts,failed_at as failedAt,last_error as lastError FROM agent_schedule_occurrences WHERE schedule_id=?').get(id) as { attempts: number; failedAt: string | null; lastError: string | null }
const failureOf = (promise: Promise<unknown>) => promise.then(() => { throw new Error('Expected a failure') }, (error: unknown) => error)

describe('schedule failures', () => {
  it('records retryable failures with backoff and fails the occurrence once retries are exhausted', async () => {
    const item = await due((await reminder({ recurrence: 'once' })).id)
    const now = Date.now()
    expect(await recordScheduleFailure(env, item, typed(429, 'run_budget', 'Daily run budget reached'), now)).toBe(now + SCHEDULE_RETRY_DELAYS[0]!)
    expect(await findSchedule(env, item.id)).toMatchObject({ status: 'active', lastError: 'Daily run budget reached', lastErrorCode: 'run_budget' })
    expect(await recordScheduleFailure(env, item, new Error('D1 internal: SELECT secret'), now)).toBe(now + SCHEDULE_RETRY_DELAYS[1]!)
    expect(await findSchedule(env, item.id)).toMatchObject({ lastError: 'Delivery failed temporarily', lastErrorCode: 'delivery_failed' })
    for (let attempt = 3; attempt <= SCHEDULE_RETRY_DELAYS.length; attempt++) expect(await recordScheduleFailure(env, item, typed(503, 'unavailable'), now)).not.toBeNull()
    expect(await recordScheduleFailure(env, item, typed(503, 'unavailable'), now)).toBeNull()
    expect(occurrence(item.id)).toMatchObject({ attempts: SCHEDULE_RETRY_DELAYS.length + 1, failedAt: expect.any(String) })
    // A one-time schedule cannot advance, so it blocks until resumed.
    expect(await findSchedule(env, item.id)).toMatchObject({ status: 'blocked', lastErrorCode: 'unavailable', lastError: expect.stringContaining('Missed after 6 attempts') })
  })
  it('never lets a retry run into the next repetition', async () => {
    const item = await due((await reminder()).id)
    const following = nextScheduleAt(item, item.nextAt!, new Date().toISOString())!
    expect(await recordScheduleFailure(env, item, typed(429, 'rate_limited'), Date.parse(following) - 10_000)).toBeNull()
    expect(await findSchedule(env, item.id)).toMatchObject({ status: 'active', nextAt: following, lastErrorCode: 'rate_limited' })
    expect(occurrence(item.id).failedAt).toEqual(expect.any(String))
  })
  it('blocks with the real reason for role reduction, channel removal and task reassignment', async () => {
    const reduced = await due((await reminder()).id)
    db.prepare('UPDATE roles SET permissions_bitmask=? WHERE id=?').run(Permission.sendMessages, 'scheduler')
    expect(await recordScheduleFailure(env, reduced, await failureOf(executeScheduledOccurrence(env, reduced, () => {})))).toBeNull()
    expect(await findSchedule(env, reduced.id)).toMatchObject({ status: 'blocked', lastErrorCode: 'schedule_revoked' })
    db.prepare('UPDATE roles SET permissions_bitmask=? WHERE id=?').run(Permission.manageSchedules | Permission.sendMessages, 'scheduler')

    const removed = await due((await reminder()).id)
    db.prepare("UPDATE channels SET visibility='private' WHERE id='public-channel'").run()
    await recordScheduleFailure(env, removed, await failureOf(executeScheduledOccurrence(env, removed, () => {})))
    expect(await findSchedule(env, removed.id)).toMatchObject({ status: 'blocked', lastErrorCode: 'channel_unavailable', lastError: expect.stringContaining('conversation') })
    db.prepare("UPDATE channels SET visibility='server' WHERE id='public-channel'").run()

    const work = await insertWork('ready', 'owner-user')
    await recordScheduleFailure(env, work, await failureOf(executeScheduledOccurrence(env, work, () => {})))
    expect(await findSchedule(env, work.id)).toMatchObject({ status: 'blocked', lastErrorCode: 'task_reassigned' })
    const messages = new Set([reduced, removed, work].map(item => db.prepare('SELECT last_error FROM agent_schedules WHERE id=?').get(item.id)!.last_error))
    expect(messages.size).toBe(3)
  })
  it('stops recurring work on a done or archived task without starting a Run', async () => {
    const work = await insertWork('done')
    await recordScheduleFailure(env, work, await failureOf(executeScheduledOccurrence(env, work, () => {})))
    expect(await findSchedule(env, work.id)).toMatchObject({ status: 'completed', nextAt: null, lastErrorCode: 'task_closed' })
    expect(db.prepare('SELECT count(*) as count FROM agent_runs').get()).toMatchObject({ count: 0 })
  })
  it.each([
    ['429', typed(429, 'run_budget'), 'active', SCHEDULE_RETRY_DELAYS[0]],
    ['5xx', new Error('Upstream 503'), 'active', SCHEDULE_RETRY_DELAYS[0]],
    ['409', typed(409, 'agent_unavailable', 'Choose an active agent'), 'blocked', null],
  ] as const)('the alarm handles a %s delivery failure without a 30 second loop', async (_label, error, status, delay) => {
    const item = await due((await reminder()).id)
    vi.mocked(sendChannelMessage).mockRejectedValue(error)
    let alarm: number | null = null
    const data = new Map<string, unknown>([['scheduleId', item.id]])
    const storage = { get: async (key: string) => data.get(key), put: async (key: string, value: unknown) => { data.set(key, value) },
      setAlarm: async (at: number) => { alarm = at }, deleteAlarm: async () => { alarm = null } }
    const object = new AgentScheduleDurableObject({ storage, waitUntil: () => {} } as never, env)
    const before = Date.now()
    await object.alarm()
    expect(await findSchedule(env, item.id)).toMatchObject({ status, lastErrorCode: expect.any(String) })
    if (delay) expect(alarm! - before).toBeGreaterThanOrEqual(delay)
    else expect(alarm).toBeNull()
  })
})

describe('schedule creation checks', () => {
  beforeEach(() => db.prepare('UPDATE roles SET permissions_bitmask=? WHERE id=?')
    .run(Permission.manageSchedules | Permission.sendMessages | Permission.executeTasks | Permission.useAgents | Permission.readTasks, 'scheduler'))
  const work = async () => createSchedule(env, (await actor())!, { ...input(), kind: 'work', agentId: 'agent-user', taskId: 'task-0001' })
  it('refuses work when agent execution is not configured', async () => {
    await insertWork()
    await expect(work()).rejects.toMatchObject({ statusCode: 409, data: { error: { code: 'pi_unconfigured' } } })
  })
  it('refuses work for a paused agent', async () => {
    await insertWork()
    vi.mocked(piConfigured).mockResolvedValue(true)
    db.prepare("UPDATE agents SET status='paused'").run()
    await expect(work()).rejects.toMatchObject({ statusCode: 409, data: { error: { code: 'agent_unavailable' } } })
  })
})

describe('schedule management', () => {
  it('cancels only unfinished schedules, including one in a conversation the owner lost', async () => {
    const lost = await reminder()
    db.prepare("UPDATE channels SET visibility='private' WHERE id='public-channel'").run()
    const listed = await listSchedules(env, (await actor())!)
    expect(listed.schedules).toEqual([expect.objectContaining({ id: lost.id, unavailable: true, content: '' })])
    expect(listed.activeCount).toBe(1)
    await cancelSchedule(env, (await actor())!, lost.id)
    expect((await findSchedule(env, lost.id))?.status).toBe('cancelled')
    await expect(cancelSchedule(env, (await actor())!, lost.id)).rejects.toMatchObject({ statusCode: 409 })
    db.prepare("UPDATE channels SET visibility='server' WHERE id='public-channel'").run()
    const done = await reminder()
    db.prepare("UPDATE agent_schedules SET status='completed',next_at=NULL WHERE id=?").run(done.id)
    await expect(cancelSchedule(env, (await actor())!, done.id)).rejects.toMatchObject({ statusCode: 409 })
    expect((await findSchedule(env, done.id))?.status).toBe('completed')
  })
  it('lists blocked then active schedules by next run, pages with a cursor and keeps history separate', async () => {
    const later = await reminder({ firstAt: new Date(Date.now() + 7200000).toISOString() })
    const sooner = await reminder({ firstAt: new Date(Date.now() + 3600000).toISOString() })
    const blocked = await reminder()
    db.prepare("UPDATE agent_schedules SET status='blocked' WHERE id=?").run(blocked.id)
    const finished: string[] = []
    for (let index = 0; index < 3; index++) finished.push((await reminder()).id)
    db.prepare("UPDATE agent_schedules SET status='cancelled',next_at=NULL WHERE id IN (?,?,?)").run(...finished)
    const auth = (await actor())!
    const first = await listSchedules(env, auth, { limit: 2 })
    expect(first.schedules.map(item => item.id)).toEqual([blocked.id, sooner.id])
    const second = await listSchedules(env, auth, { limit: 2, cursor: first.nextCursor! })
    expect(second.schedules.map(item => item.id)).toEqual([later.id])
    expect(second.nextCursor).toBeNull()
    expect(first.activeCount).toBe(2)
    const history = await listSchedules(env, auth, { status: 'history', limit: 2 })
    const rest = await listSchedules(env, auth, { status: 'history', limit: 2, cursor: history.nextCursor! })
    expect([...history.schedules, ...rest.schedules].map(item => item.id).sort()).toEqual(finished.sort())
    expect((await listSchedules(env, auth, { status: 'blocked' })).schedules.map(item => item.id)).toEqual([blocked.id])
  })
  it('pauses, resumes past missed repetitions, removes finished schedules and shows occurrences', async () => {
    const auth = (await actor())!
    const item = await reminder()
    vi.mocked(sendChannelMessage).mockResolvedValue({} as Awaited<ReturnType<typeof sendChannelMessage>>)
    await executeScheduledOccurrence(env, await due(item.id), () => {})
    expect(await listScheduleOccurrences(env, auth, item.id)).toEqual([expect.objectContaining({ completedAt: expect.any(String), messageId: expect.any(String) })])
    expect((await pauseSchedule(env, auth, item.id)).status).toBe('paused')
    await expect(pauseSchedule(env, auth, item.id)).rejects.toMatchObject({ statusCode: 409 })
    const paused = await due(item.id, new Date(Date.now() - 3 * 86400000).toISOString())
    await executeScheduledOccurrence(env, paused, () => {})
    expect(sendChannelMessage).toHaveBeenCalledOnce()
    expect((await listSchedules(env, auth, { status: 'paused' })).schedules).toHaveLength(1)
    const resumed = await resumeSchedule(env, auth, item.id)
    expect(resumed.status).toBe('active')
    expect(Date.parse(resumed.nextAt!)).toBeGreaterThan(Date.now())
    await expect(dismissSchedule(env, auth, item.id)).rejects.toMatchObject({ statusCode: 409 })
    await cancelSchedule(env, auth, item.id)
    await dismissSchedule(env, auth, item.id)
    expect((await listSchedules(env, auth, { status: 'history' })).schedules).toEqual([])
  })
  it('resumes a blocked schedule only after its cause is fixed', async () => {
    const auth = (await actor())!
    const item = await due((await reminder({ recurrence: 'once' })).id)
    db.prepare("UPDATE channels SET visibility='private' WHERE id='public-channel'").run()
    await recordScheduleFailure(env, item, await failureOf(executeScheduledOccurrence(env, item, () => {})))
    await expect(resumeSchedule(env, auth, item.id)).rejects.toMatchObject({ data: { error: { code: 'channel_unavailable' } } })
    db.prepare("UPDATE channels SET visibility='server' WHERE id='public-channel'").run()
    // A one-time reminder whose time passed is delivered as soon as it is resumed.
    expect(await resumeSchedule(env, auth, item.id)).toMatchObject({ status: 'active', nextAt: item.nextAt, lastError: null })
  })
  it('keeps a bounded occurrence history', async () => {
    const item = await reminder()
    const insert = db.prepare("INSERT INTO agent_schedule_occurrences(schedule_id,due_at,message_id,completed_at) VALUES (?,?,?,'2026-01-01')")
    for (let index = 0; index < 120; index++) insert.run(item.id, new Date(Date.parse('2025-01-01') + index * 86400000).toISOString(), `message-${index}`)
    vi.mocked(sendChannelMessage).mockResolvedValue({} as Awaited<ReturnType<typeof sendChannelMessage>>)
    await executeScheduledOccurrence(env, await due(item.id), () => {})
    expect(db.prepare('SELECT count(*) as count FROM agent_schedule_occurrences').get()).toMatchObject({ count: 100 })
  })
})

describe('schedule edits', () => {
  const saved = (id: string) => JSON.parse((db.prepare('SELECT authorization_json FROM agent_schedules WHERE id=?').get(id) as { authorization_json: string }).authorization_json)
  it('replaces content, time, repetition and the saved ceiling, and re-arms the scheduler', async () => {
    const item = await reminder({ recurrence: 'once' })
    wake.mockClear()
    const firstAt = new Date(Date.now() + 7200000).toISOString()
    const edited = await updateSchedule(env, (await actor())!, item.id, { content: 'Review the new evidence', firstAt, timezone: 'UTC', recurrence: 'weekly' })
    expect(edited).toMatchObject({ status: 'active', content: 'Review the new evidence', firstAt, nextAt: firstAt, timezone: 'UTC', recurrence: 'weekly' })
    expect(edited).not.toHaveProperty('authorizationJson')
    expect(wake).toHaveBeenCalledWith(item.id)
    // Content alone keeps the next occurrence and its identity.
    expect(await updateSchedule(env, (await actor())!, item.id, { content: 'Only text' })).toMatchObject({ content: 'Only text', nextAt: firstAt })
    await expect(updateSchedule(env, (await actor())!, item.id, { firstAt: new Date(Date.now() - 60000).toISOString() })).rejects.toMatchObject({ statusCode: 400, data: { error: { code: 'schedule_time' } } })
    await expect(updateSchedule(env, (await actor())!, item.id, { taskId: 'task-0001' })).rejects.toMatchObject({ statusCode: 400 })
  })
  it('lets only the creator edit, and only unfinished schedules', async () => {
    const item = await reminder()
    const other = (await loadAuthorizationContext(env, { principalId: 'owner-user', credential: { kind: 'session' } }))!
    await expect(updateSchedule(env, other, item.id, { content: 'Mine now' })).rejects.toMatchObject({ statusCode: 404 })
    // A reminder an Agent created for this person is the Agent's to edit.
    db.exec(`INSERT INTO users(id,kind,display_name,status,role_id,joined_at) VALUES('agent-user','agent','Agent','active','scheduler','2026-10-21')`)
    db.prepare("UPDATE agent_schedules SET principal_id='agent-user' WHERE id=?").run(item.id)
    await expect(updateSchedule(env, (await actor())!, item.id, { content: 'Mine now' })).rejects.toMatchObject({ statusCode: 403, data: { error: { code: 'schedule_denied' } } })
    db.prepare("UPDATE agent_schedules SET principal_id='human-user' WHERE id=?").run(item.id)
    for (const status of ['completed', 'cancelled']) {
      db.prepare('UPDATE agent_schedules SET status=?,next_at=NULL WHERE id=?').run(status, item.id)
      await expect(updateSchedule(env, (await actor())!, item.id, { content: 'Again' })).rejects.toMatchObject({ statusCode: 409, data: { error: { code: 'schedule_inactive' } } })
    }
    expect((await findSchedule(env, item.id))?.content).toBe('Review evidence')
  })
  it('re-authorizes from current grants, so an edit never restores a reduced role', async () => {
    db.prepare('UPDATE roles SET permissions_bitmask=? WHERE id=?').run(Permission.manageSchedules | Permission.sendMessages | Permission.writeData, 'scheduler')
    const item = await reminder()
    expect(saved(item.id).principal.permissions & Permission.writeData).toBe(Permission.writeData)
    db.prepare('UPDATE roles SET permissions_bitmask=? WHERE id=?').run(Permission.manageSchedules | Permission.sendMessages, 'scheduler')
    await updateSchedule(env, (await actor())!, item.id, { content: 'Reduced' })
    expect(saved(item.id).principal.permissions & Permission.writeData).toBe(0)
    db.prepare('UPDATE roles SET permissions_bitmask=? WHERE id=?').run(Permission.manageSchedules, 'scheduler')
    await expect(updateSchedule(env, (await actor())!, item.id, { content: 'Cannot send' })).rejects.toMatchObject({ statusCode: 403 })
    expect(await findSchedule(env, item.id)).toMatchObject({ content: 'Reduced', status: 'active' })
  })
  it('refuses work an edit could not create', async () => {
    db.prepare('UPDATE roles SET permissions_bitmask=? WHERE id=?').run(Permission.manageSchedules | Permission.sendMessages | Permission.executeTasks | Permission.useAgents | Permission.readTasks, 'scheduler')
    const work = await insertWork()
    db.prepare('UPDATE agent_schedules SET next_at=? WHERE id=?').run(new Date(Date.now() + 3600000).toISOString(), work.id)
    await expect(updateSchedule(env, (await actor())!, work.id, { content: 'Do more' })).rejects.toMatchObject({ statusCode: 409, data: { error: { code: 'pi_unconfigured' } } })
    vi.mocked(piConfigured).mockResolvedValue(true)
    db.prepare('UPDATE roles SET permissions_bitmask=? WHERE id=?').run(Permission.manageSchedules | Permission.sendMessages | Permission.executeTasks | Permission.readTasks, 'scheduler')
    await expect(updateSchedule(env, (await actor())!, work.id, { content: 'Do more' })).rejects.toMatchObject({ statusCode: 403, data: { error: { code: 'schedule_denied' } } })
    expect((await findSchedule(env, work.id))?.content).toBe('Do it')
  })
  it('recomputes the next run in the new zone and keeps its wall time through DST', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-20T00:00:00Z'))
    try {
      const item = await reminder()
      // 09:00 in New York the day before clocks move back.
      const edited = await updateSchedule(env, (await actor())!, item.id, { firstAt: '2026-10-31T09:00:00-04:00', timezone: 'America/New_York', recurrence: 'daily' })
      expect(edited.nextAt).toBe('2026-10-31T13:00:00.000Z')
      expect(nextScheduleAt((await findSchedule(env, item.id))!, edited.nextAt!, '2026-10-31T14:00:00Z')).toBe('2026-11-01T14:00:00.000Z')
    } finally { vi.useRealTimers() }
  })
  it('keeps a paused schedule paused and the alarm follows each edit', async () => {
    let alarm: number | null = null
    const data = new Map<string, unknown>()
    const storage = { get: async (key: string) => data.get(key), put: async (key: string, value: unknown) => { data.set(key, value) },
      setAlarm: async (at: number) => { alarm = at }, deleteAlarm: async () => { alarm = null } }
    const object = new AgentScheduleDurableObject({ storage, waitUntil: () => {} } as never, env)
    env.AGENT_SCHEDULE_DO = { getByName: () => object } as unknown as L4Env['AGENT_SCHEDULE_DO']
    const auth = (await actor())!
    const item = await reminder()
    expect(alarm).toBe(Date.parse(item.nextAt!))
    const later = new Date(Date.now() + 3 * 3600000).toISOString()
    await updateSchedule(env, auth, item.id, { firstAt: later })
    expect(alarm).toBe(Date.parse(later))
    await pauseSchedule(env, auth, item.id)
    const paused = await updateSchedule(env, auth, item.id, { firstAt: new Date(Date.now() + 4 * 3600000).toISOString(), content: 'Still paused' })
    expect(paused).toMatchObject({ status: 'paused', content: 'Still paused' })
    expect(alarm).toBeNull()
    expect((await resumeSchedule(env, auth, item.id)).nextAt).toBe(paused.nextAt)
    expect(alarm).toBe(Date.parse(paused.nextAt!))
  })
  it('does not move a due occurrence that may be delivering, and keeps its history', async () => {
    const item = await due((await reminder()).id)
    vi.mocked(sendChannelMessage).mockResolvedValue({} as Awaited<ReturnType<typeof sendChannelMessage>>)
    await expect(updateSchedule(env, (await actor())!, item.id, { firstAt: new Date(Date.now() + 3600000).toISOString() }))
      .rejects.toMatchObject({ statusCode: 409, data: { error: { code: 'schedule_due' } } })
    // A content edit during delivery keeps the occurrence identity, so it is delivered once and advances.
    await updateSchedule(env, (await actor())!, item.id, { content: 'Edited meanwhile' })
    await executeScheduledOccurrence(env, item, () => {})
    expect(sendChannelMessage).toHaveBeenCalledOnce()
    const after = (await findSchedule(env, item.id))!
    expect(after).toMatchObject({ content: 'Edited meanwhile', status: 'active' })
    expect(Date.parse(after.nextAt!)).toBeGreaterThan(Date.now())
    await updateSchedule(env, (await actor())!, item.id, { firstAt: new Date(Date.now() + 7200000).toISOString() })
    expect(await listScheduleOccurrences(env, (await actor())!, item.id)).toEqual([expect.objectContaining({ dueAt: item.nextAt, completedAt: expect.any(String) })])
  })
  it('returns a blocked schedule to active only once the checks pass', async () => {
    const item = await due((await reminder({ recurrence: 'once' })).id)
    db.prepare("UPDATE channels SET visibility='private' WHERE id='public-channel'").run()
    await recordScheduleFailure(env, item, await failureOf(executeScheduledOccurrence(env, item, () => {})))
    await expect(updateSchedule(env, (await actor())!, item.id, { content: 'Try again' })).rejects.toMatchObject({ statusCode: 404 })
    expect(await findSchedule(env, item.id)).toMatchObject({ status: 'blocked', lastErrorCode: 'channel_unavailable', content: 'Review evidence' })
    db.prepare("UPDATE channels SET visibility='server' WHERE id='public-channel'").run()
    const firstAt = new Date(Date.now() + 3600000).toISOString()
    expect(await updateSchedule(env, (await actor())!, item.id, { firstAt })).toMatchObject({ status: 'active', nextAt: firstAt, lastError: null, lastErrorCode: null })
  })
})
