import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createError } from 'h3'
import { INIT_SQL } from '../../server/utils/db'
import { d1 } from '../helpers/sqlite-d1'
import { createRecord, updateRecord } from '../../server/utils/record-service'
import { insertDatabaseField } from '../../server/utils/database-field-service'
import { ALL_PERMISSIONS } from '../../shared/permissions'
import type { AuthorizationContext } from '../../shared/authorization'
import type { DatabaseFieldType } from '../../shared/database'
import type { L4Env } from '../../workers/env'

let db: DatabaseSync, env: L4Env
const auth: AuthorizationContext = { serverId: '00000000-0000-4000-8000-000000000001', principal: { id: 'owner', kind: 'human', roleId: 'owner', roleName: 'Owner', permissions: ALL_PERMISSIONS, isOwner: true }, credential: { kind: 'session' } }
beforeEach(() => {
  vi.stubGlobal('createError', createError)
  db = new DatabaseSync(':memory:'); db.exec(INIT_SQL)
  db.exec(`INSERT INTO roles(id,key,name,permissions_bitmask) VALUES('owner','owner','Owner',${ALL_PERMISSIONS});
    INSERT INTO users(id,display_name,status,role_id,joined_at) VALUES('owner','Owner','active','owner','2026-11-03');
    INSERT INTO server_identity(singleton,id) VALUES(1,'${auth.serverId}');
    INSERT INTO server(id,name,owner_id) VALUES('${auth.serverId}','Test','owner');
    INSERT INTO database_definitions(id,name,created_by) VALUES('db','Records','owner');
    INSERT INTO database_fields(id,database_id,name,type,slot,config_json,created_by) VALUES('rel','db','Related','relation','links_1','{"relation":{"databaseId":"db"}}','owner');
    INSERT INTO data_items(id,database_id,title,created_by) VALUES('a','db','A','owner'),('b','db','B','owner');`)
  env = { DB: d1(db) } as L4Env
})
afterEach(() => { db.close(); vi.unstubAllGlobals() })

it('rolls the scalar values and version back if a relation write fails', async () => {
  const item = await createRecord(env, auth, 'db', { title: 'Original', values: { rel: ['a'] } })
  db.exec("CREATE TRIGGER reject_b BEFORE INSERT ON database_item_links WHEN NEW.target_item_id='b' BEGIN SELECT RAISE(ABORT, 'failed link'); END")
  await expect(updateRecord(env, auth, item.id, { version: 1, title: 'Changed', values: { rel: ['b'] } })).rejects.toThrow('failed link')
  expect(db.prepare('SELECT title,version FROM data_items WHERE id=?').get(item.id)).toEqual({ title: 'Original', version: 1 })
  expect(db.prepare('SELECT target_item_id FROM database_item_links WHERE item_id=?').all(item.id)).toEqual([{ target_item_id: 'a' }])
})

it('a writer made stale immediately before its transaction cannot replace links', async () => {
  const item = await createRecord(env, auth, 'db', { values: { rel: ['a'] } })
  const original = env.DB.batch.bind(env.DB)
  env.DB.batch = async statements => {
    db.prepare('UPDATE data_items SET version=version+1, mutation_id=? WHERE id=?').run('other-writer', item.id)
    return original(statements)
  }
  await expect(updateRecord(env, auth, item.id, { version: 1, values: { rel: ['b'] } })).rejects.toMatchObject({ statusCode: 409 })
  expect(db.prepare('SELECT target_item_id FROM database_item_links WHERE item_id=?').all(item.id)).toEqual([{ target_item_id: 'a' }])
})

it('returns the committed relation snapshot even when another transaction writes before the response', async () => {
  const item = await createRecord(env, auth, 'db', { values: { rel: ['a'] } })
  const original = env.DB.batch.bind(env.DB)
  env.DB.batch = async statements => {
    const result = await original(statements)
    db.prepare('UPDATE data_items SET version=version+1 WHERE id=?').run(item.id)
    db.prepare('DELETE FROM database_item_links WHERE item_id=?').run(item.id)
    return result
  }
  expect(await updateRecord(env, auth, item.id, { version: 1, values: { rel: ['b'] } })).toMatchObject({ version: 2, values: { rel: ['b'] } })
  expect(db.prepare('SELECT COUNT(*) AS n FROM database_item_links WHERE item_id=?').get(item.id)).toEqual({ n: 0 })
})

it.each([['text', 'url'], ['select', 'multi_select'], ['text', 'text']] as const)('concurrent %s / %s creates claim distinct physical slots', async (first, second) => {
  const insert = (id: string, type: DatabaseFieldType) => insertDatabaseField(env, { id, databaseId: 'db', name: id, type, options: [], relation: null, position: 0, createdAt: 'now', updatedAt: 'now' }, 'owner')
  await Promise.all([insert('one', first), insert('two', second)])
  const rows = db.prepare("SELECT slot FROM database_fields WHERE id IN ('one','two')").all()
  expect(rows).toHaveLength(2)
  expect(new Set(rows.map(row => row.slot)).size).toBe(2)
  expect(() => db.prepare('UPDATE database_fields SET slot=? WHERE id=?').run(rows[0]!.slot!, 'two')).toThrow()
})
