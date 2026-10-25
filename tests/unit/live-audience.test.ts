import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { INIT_SQL } from '../../server/utils/db'
import { d1 } from '../helpers/sqlite-d1'
import { Permission, ALL_PERMISSIONS } from '../../shared/permissions'
import { filterLiveRecipients } from '../../workers/live-audience'
import { signalLiveChanged } from '../../workers/live-events'
import { liveNotificationStatement } from '../../workers/notifications'
import type { L4Env } from '../../workers/env'
import type { LiveState } from '../../shared/types'
let db: DatabaseSync, env: L4Env
const notify = vi.fn(async () => {})
const live: LiveState = { active: true, meetingId: 'private-meeting-canary', participantIds: ['reader'], startedBy: 'reader', startedAt: '2026-10-24', kind: 'live', ringing: false }
beforeEach(() => {
  notify.mockClear(); db = new DatabaseSync(':memory:'); db.exec(INIT_SQL)
  db.exec(`INSERT INTO server_identity(singleton,id) VALUES(1,'00000000-0000-4000-8000-000000000001');
    INSERT INTO roles(id,key,name,permissions_bitmask,resource_access_json) VALUES
      ('owner-role','owner','Owner',${ALL_PERMISSIONS},'{}'),
      ('reader-role','custom:reader','Reader',${Permission.readTasks},'{"boards":["allowed"]}'),
      ('no-read-role','custom:no-read','No read',0,'{}'),
      ('no-board-role','custom:no-board','No board',${Permission.readTasks},'{"boards":["private"]}');
    INSERT INTO users(id,kind,display_name,status,role_id,joined_at) VALUES
      ('owner','human','Owner','active','owner-role','2026-10-24'),('reader','human','Reader','active','reader-role','2026-10-24'),
      ('no-read','human','No read','active','no-read-role','2026-10-24'),('no-board','human','No board','active','no-board-role','2026-10-24'),
      ('agent','agent','Agent','active','reader-role','2026-10-24'),('removed','human','Removed','removed',NULL,NULL);
    INSERT INTO server(id,name,owner_id) VALUES('00000000-0000-4000-8000-000000000001','Fixture','owner');
    INSERT INTO channels(id,name,type,visibility,parent_id) VALUES
      ('discussion','Secret task','text','server',NULL),('public','Public','text','server',NULL),
      ('private','Private','text','private',NULL),('dm','DM','dm','private',NULL);
    INSERT INTO messages(id,channel_id,author_id,content,created_at) VALUES('parent-msg','private','reader','hello','2026-10-24');
    INSERT INTO channels(id,name,type,visibility,parent_id,parent_message_id) VALUES('thread','Thread','thread','server','private','parent-msg');
    INSERT INTO channel_members(channel_id,user_id,joined_at) VALUES('private','reader','2026-10-24'),('dm','reader','2026-10-24'),('dm','agent','2026-10-24');
    INSERT INTO task_boards(id,name,created_by) VALUES('allowed','Allowed','owner');
    INSERT INTO tasks(id,board_id,title,discussion_channel_id,created_by) VALUES('task','allowed','Secret task','discussion','owner');`)
  env = { DB: d1(db), SERVER_DO: { getByName: () => ({ notifyLiveChanged: notify }) } } as unknown as L4Env
})
afterEach(() => db.close())
it('sends task-discussion Live events only to humans with current Read tasks and board access', async () => {
  await signalLiveChanged(env, 'discussion', live)
  expect(notify).toHaveBeenCalledWith(expect.objectContaining({ live }), ['owner', 'reader'])
  db.exec("UPDATE roles SET resource_access_json='{\"boards\":[]}' WHERE id='reader-role'")
  await signalLiveChanged(env, 'discussion', live)
  expect(notify.mock.calls.at(-1)?.[1]).toEqual(['owner'])
})
it('uses the same authorized audience for push outbox recipients', async () => {
  const prepare = env.DB.prepare.bind(env.DB)
  let recipients: unknown[] = []
  env.DB.prepare = (sql: string) => {
    const statement = prepare(sql)
    if (sql.includes('INSERT OR IGNORE INTO notification_outbox')) {
      const bind = statement.bind.bind(statement)
      statement.bind = (...args: unknown[]) => { recipients = args.slice(6); return bind(...args) }
    }
    return statement
  }
  await liveNotificationStatement(env, 'discussion', 'meeting', { id: 'owner', kind: 'human', displayName: 'Owner', avatarR2Key: null }, 'live')
  expect(recipients).toEqual(['reader'])
})
it('inherits private membership for thread Live events without an Owner bypass', async () => {
  await signalLiveChanged(env, 'thread', live)
  expect(notify.mock.calls[0]?.[1]).toEqual(['reader'])
})
it('keeps ordinary public rooms visible and excludes inactive accounts and Agents', async () => {
  expect(await filterLiveRecipients(env, 'public', ['owner','reader','no-read','no-board','agent','removed'])).toEqual(['no-board','no-read','owner','reader'])
})
it('does not reveal an Agent DM to a human lacking Use agents', async () => {
  expect(await filterLiveRecipients(env, 'dm', ['owner','reader'])).toEqual([])
  db.exec(`UPDATE roles SET permissions_bitmask=${Permission.useAgents} WHERE id='reader-role'`)
  expect(await filterLiveRecipients(env, 'dm', ['reader'])).toEqual(['reader'])
})


it('never announces mailbox Live metadata', async () => {
  db.exec("INSERT INTO email_domains(id,zone_id,domain,app_hostname) VALUES('domain','zone','example.com','app.example.com'); INSERT INTO email_mailboxes(channel_id,domain_id,local_part,display_name) VALUES('private','domain','inbox','Inbox');")
  expect(await filterLiveRecipients(env, 'private', ['reader'])).toEqual([])
  await signalLiveChanged(env, 'private', live)
  expect(notify).not.toHaveBeenCalled()
})


it('keeps recipient queries within D1 binding limits for a larger community', async () => {
  const ids = Array.from({ length: 125 }, (_, n) => `member-${String(n).padStart(3, '0')}`)
  for (const id of ids) db.prepare("INSERT INTO users(id,kind,display_name,status,role_id,joined_at) VALUES(?,'human',?,'active','reader-role','2026-10-24')").run(id, id)
  const prepare = env.DB.prepare.bind(env.DB)
  env.DB.prepare = (sql: string) => {
    const statement = prepare(sql), bind = statement.bind.bind(statement)
    statement.bind = (...args: unknown[]) => { expect(args.length).toBeLessThanOrEqual(100); return bind(...args) }
    return statement
  }
  expect(await filterLiveRecipients(env, 'discussion', ids)).toEqual(ids)
})
