import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { INIT_SQL } from '../../server/utils/db'
import { toDmDtos } from '../../server/utils/dms'
import type { L4Env } from '../../workers/env'
import { d1 } from '../helpers/sqlite-d1'

let sqlite: DatabaseSync
let prepared: string[]
let env: L4Env

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec(INIT_SQL)
  sqlite.exec(`
    INSERT INTO server_identity(singleton,id) VALUES (1,'00000000-0000-4000-8000-000000000001');
    INSERT INTO roles(id,key,name,permissions_bitmask) VALUES ('owner-role','owner','Owner',0);
    INSERT INTO users(id,kind,display_name,status,role_id,joined_at) VALUES
      ('me','human','Me','active','owner-role','2026-10-21'),
      ('agent','agent','Helper','active','owner-role','2026-10-21'),
      ('gone','human','Gone','removed',NULL,NULL);
    INSERT INTO server(id,name,owner_id) VALUES ('00000000-0000-4000-8000-000000000001','DMs','me');
  `)
  for (let index = 0; index < 8; index += 1) {
    sqlite.exec(`INSERT INTO users(id,kind,display_name,status,role_id,joined_at) VALUES ('friend-${index}','human','Friend ${index}','active','owner-role','2026-10-21')`)
  }
  const db = d1(sqlite)
  prepared = []
  env = { DB: { ...db, prepare: (sql: string) => { prepared.push(sql); return db.prepare(sql) } } } as unknown as L4Env
})

afterEach(() => sqlite.close())

function dm(id: string, others: string[]) {
  sqlite.exec(`INSERT INTO channels(id,name,type,visibility) VALUES ('${id}','dm','dm','private')`)
  for (const user of ['me', ...others]) sqlite.exec(`INSERT INTO channel_members(channel_id,user_id,joined_at) VALUES ('${id}','${user}','2026-10-21')`)
  return sqlite.prepare('SELECT * FROM channels WHERE id=?').get(id) as Record<string, unknown>
}

function rows(ids: string[]) {
  return ids.map(id => {
    const row = sqlite.prepare('SELECT * FROM channels WHERE id=?').get(id) as Record<string, string | number | null>
    return { id: row.id, name: row.name, topic: row.topic, type: row.type, visibility: row.visibility, position: row.position, liveMeetingId: row.live_meeting_id,
      parentId: row.parent_id, parentMessageId: row.parent_message_id, createdAt: row.created_at, updatedAt: row.updated_at, dmKind: row.dm_kind, dmOwnerId: row.dm_owner_id }
  }) as never
}

describe('DM list hydration', () => {
  it('hydrates participants, frozen state, Agent activity and last messages', async () => {
    dm('agent-dm', ['agent'])
    dm('frozen-dm', ['gone'])
    sqlite.exec(`
      INSERT INTO messages(id,channel_id,author_id,content,created_at) VALUES ('m1','agent-dm','agent','Root reply','2026-10-22T00:00:00Z');
      INSERT INTO channels(id,name,type,visibility,parent_id,parent_message_id) VALUES ('agent-thread','Work','thread','server','agent-dm','m1');
      INSERT INTO messages(id,channel_id,author_id,content,created_at) VALUES ('m2','agent-thread','agent','Latest from the thread','2026-10-23T00:00:00Z');
      INSERT INTO agents(user_id,created_by) VALUES ('agent','me');
    `)
    const [agentDm, frozenDm] = await toDmDtos(env, rows(['agent-dm', 'frozen-dm']), 'me', id => id === 'agent-dm')
    expect(agentDm).toMatchObject({ id: 'agent-dm', title: 'Helper', unread: true, frozen: false, lastAgentMessage: 'Latest from the thread', agentWorking: false, lastMessageAt: '2026-10-23T00:00:00Z' })
    expect(frozenDm).toMatchObject({ id: 'frozen-dm', title: 'Gone', unread: false, frozen: true, lastMessageAt: null })
    expect(frozenDm).not.toHaveProperty('lastAgentMessage')
  })

  it('uses the same number of queries regardless of DM count', async () => {
    const few = [dm('dm-0', ['friend-0']).id, dm('dm-1', ['agent']).id] as string[]
    await toDmDtos(env, rows(few), 'me', () => false) // The Server ID is cached after its first read.
    prepared = []
    await toDmDtos(env, rows(few), 'me', () => false)
    const baseline = prepared.length
    const many = [...few]
    for (let index = 1; index < 8; index += 1) many.push(dm(`dm-${index + 1}`, [`friend-${index}`]).id as string)
    prepared = []
    await toDmDtos(env, rows(many), 'me', () => false)
    expect(prepared.length).toBe(baseline)
  })
})
