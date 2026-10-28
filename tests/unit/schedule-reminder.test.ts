import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { INIT_SQL } from '../../server/utils/db'
import { d1 } from '../helpers/sqlite-d1'
import { Permission } from '../../shared/permissions'
import { loadAuthorizationContext } from '../../server/utils/authorization'
import { createSchedule, executeScheduledOccurrence, findSchedule } from '../../server/utils/schedule-service'
import { channelHasUnread } from '../../workers/unread'
import type { L4Env } from '../../workers/env'

let db: DatabaseSync
let env: L4Env
let pending: Promise<unknown>[]
const activity = vi.fn(async () => {})
beforeEach(() => {
  pending = []
  activity.mockClear()
  db = new DatabaseSync(':memory:')
  db.exec(INIT_SQL)
  db.exec(`INSERT INTO server_identity(singleton,id) VALUES(1,'00000000-0000-4000-8000-000000000001');
    INSERT INTO roles(id,key,name,permissions_bitmask) VALUES('scheduler','custom:scheduler','Scheduler',${Permission.manageSchedules | Permission.sendMessages});
    INSERT INTO users(id,display_name,status,role_id,joined_at) VALUES('human-user','Human','active','scheduler','2026-10-21'),('owner-user','Owner','active','scheduler','2026-10-21');
    INSERT INTO server(id,name,owner_id) VALUES('00000000-0000-4000-8000-000000000001','Test','owner-user');
    INSERT INTO channels(id,name,type,visibility) VALUES('public-channel','Public','text','server');
    INSERT INTO push_subscriptions(id,user_id,endpoint,p256dh,auth,created_at,updated_at) VALUES ('push-1','human-user','https://push.example/test','key','auth','2026-10-21','2026-10-21');`)
  env = { DB: d1(db), AGENT_SCHEDULE_DO: { getByName: () => ({ wake: async () => {} }) },
    CHANNEL_DO: { getByName: () => ({ fanout: async () => {} }) },
    SERVER_DO: { getByName: () => ({ notifyChannelActivity: activity, notifyChannelRead: async () => {} }) } } as unknown as L4Env
})
afterEach(async () => { await Promise.allSettled(pending); db.close() })

describe('reminder delivery', () => {
  it('leaves the reminder unread and notifies the person who set it, once per occurrence', async () => {
    const auth = (await loadAuthorizationContext(env, { principalId: 'human-user', credential: { kind: 'session' } }))!
    const created = await createSchedule(env, auth, { channelId: 'public-channel', kind: 'reminder', content: 'Stand up', firstAt: new Date(Date.now() + 60000).toISOString(), timezone: 'UTC', recurrence: 'once' })
    db.prepare('UPDATE agent_schedules SET next_at=? WHERE id=?').run(new Date(Date.now() - 1000).toISOString(), created.id)
    const item = (await findSchedule(env, created.id))!
    await executeScheduledOccurrence(env, item, promise => { pending.push(promise) })
    await Promise.all(pending)
    expect(db.prepare('SELECT author_id as authorId,content FROM messages').all()).toEqual([{ authorId: 'human-user', content: 'Reminder: Stand up' }])
    expect(await channelHasUnread(env.DB, 'human-user', 'public-channel')).toBe(true)
    expect(db.prepare('SELECT recipient_id as recipientId,kind FROM notification_outbox').all()).toEqual([{ recipientId: 'human-user', kind: 'mention' }])
    expect(activity).toHaveBeenCalledWith(expect.anything(), expect.arrayContaining(['human-user']))
    // A retry of the same occurrence reuses its delivery id.
    db.prepare("UPDATE agent_schedules SET status='active',next_at=? WHERE id=?").run(item.nextAt, item.id)
    db.prepare('UPDATE agent_schedule_occurrences SET completed_at=NULL').run()
    await executeScheduledOccurrence(env, (await findSchedule(env, item.id))!, promise => { pending.push(promise) })
    expect(db.prepare('SELECT count(*) as count FROM messages').get()).toMatchObject({ count: 1 })
    expect(db.prepare('SELECT count(*) as count FROM notification_outbox').get()).toMatchObject({ count: 1 })
  })
})
