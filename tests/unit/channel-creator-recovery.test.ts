import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { d1 } from '../helpers/sqlite-d1'
import { INIT_SQL } from '../../server/utils/db'
import { assignMissingChannelCreator, creatorCandidates, orphanedPrivateChannels } from '../../server/utils/channel-creator-recovery'
import type { L4Env } from '../../workers/env'

const serverId = '00000000-0000-4000-8000-000000000001'
let db: DatabaseSync
let env: L4Env
beforeEach(() => {
  db = new DatabaseSync(':memory:'); db.exec(INIT_SQL)
  db.exec(`INSERT INTO roles(id,key,name,permissions_bitmask) VALUES('role','member','Member',0); INSERT INTO users(id,kind,display_name,status,role_id,joined_at) VALUES('owner','human','Owner','active','role','2026-10-23'),('alice','human','Alice','active','role','2026-10-23'),('bob','human','Bob','active','role','2026-10-23'),('removed','human','Removed','removed',NULL,NULL),('agent','agent','Agent','active','role','2026-10-23');
    INSERT INTO server_identity(singleton,id) VALUES(1,'${serverId}'); INSERT INTO server(id,name,owner_id) VALUES('${serverId}','Community','owner');
    INSERT INTO channels(id,name,type,visibility,created_by) VALUES('orphan','Old group','text','private',NULL),('known','Known creator','text','private','alice'),('dm','dm','dm','private',NULL),('general','General','text','server',NULL);
    INSERT INTO channel_members(channel_id,user_id,joined_at) VALUES('orphan','alice','2026-10-23'),('orphan','removed','2026-10-23'),('orphan','agent','2026-10-23');
    INSERT INTO messages(id,channel_id,author_id,content,created_at) VALUES('history','orphan','alice','Keep history','2026-10-23');`)
  env = { DB: d1(db) } as L4Env
})
afterEach(() => db.close())
it('shows only eligible private channels and searches current human participants', async () => {
  expect(await orphanedPrivateChannels(env, 1)).toEqual({ channels: [{ id: 'orphan', name: 'Old group' }], total: 1 })
  expect(await creatorCandidates(env, 'orphan', 'AL')).toEqual({ members: [{ id: 'alice', label: 'Alice' }], hasMore: false })
})
it('lets the owner assign an existing participant, atomically auditing without granting membership or changing history', async () => {
  expect(await assignMissingChannelCreator(env, serverId, 'owner', 'orphan', 'alice')).toEqual({ createdBy: 'alice' })
  expect(db.prepare('SELECT created_by FROM channels WHERE id=?').get('orphan')?.created_by).toBe('alice')
  expect(db.prepare('SELECT action,actor_id,meta_json FROM audit_log').all()).toEqual([{ action: 'channel.creator.assign', actor_id: 'owner', meta_json: '{"userId":"alice"}' }])
  expect(db.prepare("SELECT user_id FROM channel_members WHERE channel_id='orphan' AND user_id='owner'").get()).toBeUndefined()
  expect(db.prepare('SELECT content FROM messages WHERE id=?').get('history')?.content).toBe('Keep history')
  await expect(assignMissingChannelCreator(env, serverId, 'owner', 'orphan', 'alice')).rejects.toMatchObject({ statusCode: 409 })
  expect(db.prepare('SELECT count(*) AS n FROM audit_log').get()?.n).toBe(1)
})
it.each([
  ['alice', 'orphan', 'alice'], ['owner', 'known', 'alice'], ['owner', 'orphan', 'bob'],
  ['owner', 'orphan', 'removed'], ['owner', 'orphan', 'agent'], ['owner', 'dm', 'alice'], ['owner', 'general', 'alice'],
])('rejects invalid recovery by %s on %s for %s without writing an audit receipt', async (actor, channel, target) => {
  await expect(assignMissingChannelCreator(env, serverId, actor, channel, target)).rejects.toMatchObject({ statusCode: 409 })
  expect(db.prepare('SELECT count(*) AS n FROM audit_log').get()?.n).toBe(0)
})
it('rolls back the assignment if the audit write fails', async () => {
  db.exec("CREATE TRIGGER audit_failure BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT,'audit unavailable'); END")
  await expect(assignMissingChannelCreator(env, serverId, 'owner', 'orphan', 'alice')).rejects.toThrow('audit unavailable')
  expect(db.prepare('SELECT created_by FROM channels WHERE id=?').get('orphan')?.created_by).toBeNull()
})
