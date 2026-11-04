import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createError } from 'h3'
import { d1 } from '../helpers/sqlite-d1'
import { INIT_SQL } from '../../server/utils/db'
import { createItem } from '../../server/utils/item-service'
import { readRecords } from '../../server/utils/record-service'
import { loadDatabasePage } from '../../server/utils/database-views'
import { defaultDatabaseViewConfig } from '../../shared/database'
import { ALL_PERMISSIONS } from '../../shared/permissions'
import type { AuthorizationContext } from '../../shared/authorization'
import type { L4Env } from '../../workers/env'
let db: DatabaseSync, env: L4Env
const auth: AuthorizationContext = { serverId: '00000000-0000-4000-8000-000000000001', principal: { id: 'owner', kind: 'human', roleId: 'owner-role', roleName: 'Owner', permissions: ALL_PERMISSIONS, isOwner: true, resourceAccess: {} }, credential: { kind: 'session' } }
beforeEach(() => {
  vi.stubGlobal('createError', createError)
  db = new DatabaseSync(':memory:'); db.exec(INIT_SQL)
  db.exec(`INSERT INTO roles(id,key,name,permissions_bitmask) VALUES('owner-role','owner','Owner',${ALL_PERMISSIONS});
    INSERT INTO users(id,kind,display_name,status,role_id,joined_at) VALUES('owner','human','Owner','active','owner-role','2026-10-24');
    INSERT INTO server_identity(singleton,id) VALUES(1,'${auth.serverId}'); INSERT INTO server(id,name,owner_id) VALUES('${auth.serverId}','Fixture','owner');
    INSERT INTO database_definitions(id,name,created_by) VALUES('table','Table','owner');
    INSERT INTO database_fields(id,database_id,name,type,slot,config_json,created_by) VALUES('done','table','Done','boolean','boolean_1','{}','owner');
    INSERT INTO data_items(id,database_id,title,boolean_1,created_by) VALUES('unset','table','A Unset',NULL,'owner'),('false','table','B False',0,'owner'),('true','table','C True',1,'owner');`)
  env = { DB: d1(db) } as L4Env
})
afterEach(() => { db.close(); vi.unstubAllGlobals() })
it('allows same-title pages with independent identity, including concurrent creates', async () => {
  const pages = await Promise.all(Array.from({length:5},()=>createItem(env,auth,{})))
  expect(new Set(pages.map(page=>page.id)).size).toBe(5)
  expect(pages.every(page=>page.title==='Untitled')).toBe(true)
  expect((await createItem(env,auth,{title:'Untitled'})).title).toBe('Untitled')
})
async function filtered(operator: 'equals'|'not_equals', value: boolean) {
  const config = { ...defaultDatabaseViewConfig(), filters: [{ fieldId: 'done', operator, value }], sorts: [{ fieldId: 'title', direction: 'asc' }] }
  db.prepare("INSERT INTO database_views(id,database_id,name,layout,config_json,created_by) VALUES('filtered','table','Filtered','table',?,'owner')").run(JSON.stringify(config))
  return loadDatabasePage(env, 'table', { page: 1, pageSize: 50 })
}
it.each([
  ['equals', false, ['unset', 'false']], ['not_equals', true, ['unset', 'false']],
  ['equals', true, ['true']], ['not_equals', false, ['true']],
] as const)('treats unset checkbox as false for %s %s', async (operator, value, ids) => {
  expect((await filtered(operator, value)).items.map(item => item.id)).toEqual(ids)
})
it('reads every record by default while applying a saved view only when requested', async () => {
  await filtered('equals', true)
  const all = await readRecords(env, auth, 'table', 1, { pageSize: 2 })
  expect(all.total).toBe(3); expect(all.view).toBeNull(); expect(all.nextPage).toBe(2)
  const last = await readRecords(env, auth, 'table', 2, { pageSize: 2 })
  expect(last.items).toHaveLength(1); expect(last.nextPage).toBeNull()
  expect(new Set([...all.items, ...last.items].map(item => item.id))).toEqual(new Set(['unset', 'false', 'true']))
  const saved = await readRecords(env, auth, 'table', 1, { viewId: 'filtered' })
  expect(saved.total).toBe(1); expect(saved.view?.id).toBe('filtered'); expect(saved.items[0]?.id).toBe('true')
  expect((await readRecords(env, auth, 'table', 1, { search: 'Unset' })).items.map(item => item.id)).toEqual(['unset'])
  await expect(readRecords(env, auth, 'table', 1, { viewId: 'missing' })).rejects.toMatchObject({ statusCode: 404 })
  await expect(readRecords(env, { ...auth, principal: { ...auth.principal, isOwner: false, resourceAccess: { databases: [] } } }, 'table')).rejects.toMatchObject({ statusCode: 403 })
})
