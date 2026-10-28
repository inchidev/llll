import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { INIT_SQL } from '../../server/utils/db'
import { dmPairKey, findPairDm, openPairDm } from '../../server/utils/dms'
import type { L4Env } from '../../workers/env'
import { d1 } from '../helpers/sqlite-d1'

let sqlite: DatabaseSync
let env: L4Env
beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec(INIT_SQL)
  sqlite.exec(`INSERT INTO roles(id,key,name,permissions_bitmask) VALUES('role','member','Member',112); INSERT INTO users(id,kind,display_name,status,joined_at,role_id) VALUES
    ('aaa-0001','human','A','active','2026-01-01','role'),('bbb-0001','human','B','active','2026-01-01','role'),('ccc-0001','human','C','active','2026-01-01','role')`)
  env = { DB: d1(sqlite) } as unknown as L4Env
})
afterEach(() => sqlite.close())
const dms = () => sqlite.prepare("SELECT id, dm_pair_key AS key FROM channels WHERE type='dm' ORDER BY id").all()

describe('1:1 DM pair key', () => {
  it('is independent of who opens the DM', () => {
    expect(dmPairKey('bbb-0001', 'aaa-0001')).toBe(dmPairKey('aaa-0001', 'bbb-0001'))
  })

  it('creates one DM when both participants open it at once', async () => {
    const first = await openPairDm(env, 'aaa-0001', 'bbb-0001')
    // The second opener looked before the first insert committed, so its lookups found nothing.
    const db = env.DB
    let stale = 2
    const racing = { DB: { ...db, batch: db.batch.bind(db), prepare: (sql: string) => {
      const statement = db.prepare(sql)
      if (stale > 0 && /^SELECT (id FROM channels WHERE dm_pair_key|a\.channel_id)/u.test(sql.trim())) {
        stale -= 1
        return { bind: () => ({ first: async () => null }) } as unknown as D1PreparedStatement
      }
      return statement
    } } } as unknown as L4Env
    const second = await openPairDm(racing, 'bbb-0001', 'aaa-0001')
    expect(stale).toBe(0)
    expect(first).toBe(second)
    expect(dms()).toEqual([{ id: first, key: 'aaa-0001:bbb-0001' }])
    expect(sqlite.prepare('SELECT count(*) AS n FROM channel_members WHERE channel_id=?').get(first)).toMatchObject({ n: 2 })
    expect(await openPairDm(env, 'aaa-0001', 'bbb-0001')).toBe(first)
  })

  it('rejects a second keyed DM for the same pair', () => {
    sqlite.exec(`INSERT INTO channels(id,name,type,visibility,dm_pair_key) VALUES('dm-1','dm','dm','private','aaa-0001:bbb-0001')`)
    expect(() => sqlite.exec(`INSERT INTO channels(id,name,type,visibility,dm_pair_key) VALUES('dm-2','dm','dm','private','aaa-0001:bbb-0001')`)).toThrow(/UNIQUE/u)
  })

  it('lets an unkeyed pair from an earlier Worker claim the key, and never reuses a group', async () => {
    sqlite.exec(`INSERT INTO channels(id,name,type,visibility,dm_kind) VALUES('legacy-pair','dm','dm','private','pair'),('shrunk-group','dm','dm','private','group');
      INSERT INTO channel_members(channel_id,user_id,joined_at) VALUES('legacy-pair','aaa-0001','2026-01-01'),('legacy-pair','bbb-0001','2026-01-01'),
        ('shrunk-group','aaa-0001','2026-01-01'),('shrunk-group','ccc-0001','2026-01-01')`)
    expect(await findPairDm(env, 'bbb-0001', 'aaa-0001')).toBe('legacy-pair')
    expect(sqlite.prepare('SELECT dm_pair_key AS key FROM channels WHERE id=?').get('legacy-pair')).toMatchObject({ key: 'aaa-0001:bbb-0001' })
    const created = await openPairDm(env, 'aaa-0001', 'ccc-0001')
    expect(created).not.toBe('shrunk-group')
  })
})

describe('0028 chat lifecycle migration', () => {
  it('keys the oldest DM of each pair and leaves duplicates and groups unkeyed', () => {
    const legacy = new DatabaseSync(':memory:')
    try {
      const sql = INIT_SQL.slice(0, INIT_SQL.indexOf('ALTER TABLE channels ADD COLUMN dm_pair_key'))
      legacy.exec(sql)
      legacy.exec(`INSERT INTO roles(id,key,name,permissions_bitmask) VALUES('role','member','Member',112); INSERT INTO users(id,kind,display_name,status,joined_at,role_id) VALUES('a','human','A','active','2026-01-01','role'),('b','human','B','active','2026-01-01','role'),('c','human','C','active','2026-01-01','role');
        INSERT INTO channels(id,name,type,visibility,dm_kind,created_at) VALUES
          ('newer','dm','dm','private','pair','2026-02-01'),('older','dm','dm','private','pair','2026-01-01'),
          ('other','dm','dm','private','pair','2026-01-01'),('group','Team','dm','private','group','2026-01-01');
        INSERT INTO channel_members(channel_id,user_id,joined_at) VALUES
          ('newer','b','2026-01-01'),('newer','a','2026-01-01'),('older','a','2026-01-01'),('older','b','2026-01-01'),
          ('other','a','2026-01-01'),('other','c','2026-01-01'),('group','a','2026-01-01'),('group','b','2026-01-01');`)
      legacy.exec(readFileSync(new URL('../../drizzle/server-migrations/0028_chat_lifecycle.sql', import.meta.url), 'utf8'))
      expect(legacy.prepare('SELECT id, dm_pair_key AS key FROM channels ORDER BY id').all()).toEqual([
        { id: 'group', key: null }, { id: 'newer', key: null }, { id: 'older', key: 'a:b' }, { id: 'other', key: 'a:c' },
      ])
    } finally { legacy.close() }
  })
})
