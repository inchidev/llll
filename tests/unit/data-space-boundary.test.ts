import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createError } from 'h3'
import { INIT_SQL } from '../../server/utils/db'
import { d1 } from '../helpers/sqlite-d1'
import { changeDataReference, listDataReferences } from '../../server/utils/data-references'
import { searchData } from '../../server/utils/data-search'
import { changeDataTrash, listDataTrash } from '../../server/utils/data-trash'
import { bulkCreateRecords } from '../../server/utils/data-transfer'
import { getItem } from '../../server/utils/item-service'
import { loadSpaceBoundary } from '../../server/utils/space-access'
import { ALL_PERMISSIONS } from '../../shared/permissions'
import type { AuthorizationContext } from '../../shared/authorization'
import type { L4Env } from '../../workers/env'

const SALES = '10000000-0000-4000-8000-000000000001'
const LEGAL = '10000000-0000-4000-8000-000000000002'
const SERVER = '00000000-0000-4000-8000-000000000001'

let db: DatabaseSync, env: L4Env

async function member(id: string, scope: string | null = null): Promise<AuthorizationContext> {
  const spaces = await loadSpaceBoundary(env, id, { scope })
  return { serverId: SERVER, principal: { id, kind: 'human', roleId: 'member', roleName: 'Member', permissions: ALL_PERMISSIONS, isOwner: false }, credential: { kind: 'session' }, spaces }
}

beforeEach(() => {
  vi.stubGlobal('createError', createError)
  db = new DatabaseSync(':memory:'); db.exec(INIT_SQL)
  db.exec(`INSERT INTO roles(id,key,name,permissions_bitmask) VALUES('member','member','Member',${ALL_PERMISSIONS});
    INSERT INTO users(id,display_name,status,role_id,joined_at) VALUES('owner','Owner','active','member','2026-11-03'),('sam','Sam','active','member','2026-11-03'),('both','Both','active','member','2026-11-03');
    INSERT INTO server_identity(singleton,id) VALUES(1,'${SERVER}');
    INSERT INTO server(id,name,owner_id) VALUES('${SERVER}','Test','owner');
    INSERT INTO spaces(id,name,created_by) VALUES('${SALES}','Sales','owner'),('${LEGAL}','Legal','owner');
    INSERT INTO space_members(space_id,user_id) VALUES('${SALES}','sam'),('${SALES}','both'),('${LEGAL}','both');
    INSERT INTO data_items(id,space_id,title,content,created_by) VALUES('sales-doc','${SALES}','Plan sales','','owner'),('legal-doc','${LEGAL}','Plan legal','','owner');
    INSERT INTO database_definitions(id,space_id,name,created_by) VALUES('sales-db','${SALES}','Plan deals','owner'),('legal-db','${LEGAL}','Plan cases','owner');
    INSERT INTO data_items(id,space_id,database_id,title,created_by) VALUES('sales-item','${SALES}','sales-db','Plan A','owner'),('legal-item','${LEGAL}','legal-db','Plan B','owner');`)
  env = { DB: d1(db) } as L4Env
})
afterEach(() => { db.close(); vi.unstubAllGlobals() })

describe('boundary', () => {
  it('lists another Space\'s pages but not its records, which the Database entry already covers', async () => {
    const denied = (await member('sam')).spaces!.denied
    expect([...denied.documents ?? []]).toEqual(['legal-doc'])
    expect([...denied.databases ?? []]).toEqual(['legal-db'])
    await expect(getItem(env, await member('sam'), 'legal-item')).rejects.toMatchObject({ statusCode: 404 })
  })
})

describe('search', () => {
  it('finds only what lives in the reachable Spaces', async () => {
    const hits = await searchData(env, await member('sam'), 'Plan')
    expect(hits.map(hit => hit.id).sort()).toEqual(['sales-db', 'sales-doc', 'sales-item'])
  })

  it('does not let another Space use up the limit', async () => {
    for (let n = 0; n < 30; n++) db.exec(`INSERT INTO data_items(id,space_id,title,content,created_by,updated_at) VALUES('l${n}','${LEGAL}','Plan ${n}','','owner','2030-01-01T00:00:00.000Z')`)
    expect((await searchData(env, await member('sam'), 'Plan')).some(hit => hit.id === 'sales-doc')).toBe(true)
  })

  it('narrows to the active Space for someone in both', async () => {
    const hits = await searchData(env, await member('both', LEGAL), 'Plan')
    expect(hits.map(hit => hit.id).sort()).toEqual(['legal-db', 'legal-doc', 'legal-item'])
  })
})

describe('Trash', () => {
  beforeEach(() => {
    db.exec("UPDATE data_items SET deleted_at='2026-11-03T00:00:00.000Z'; UPDATE data_items SET deleted_at='2026-11-03T00:00:00.000Z'")
  })

  it('lists only the reachable Spaces, including records by their parent', async () => {
    expect((await listDataTrash(env, await member('sam'))).map(entry => entry.id).sort()).toEqual(['sales-doc', 'sales-item'])
  })

  it('refuses to restore or purge across the boundary, whatever the ID', async () => {
    const auth = await member('sam')
    await expect(changeDataTrash(env, auth, 'item', 'legal-doc', 'restore')).rejects.toThrow()
    await expect(changeDataTrash(env, auth, 'item', 'legal-doc', 'purge')).rejects.toThrow()
    expect(db.prepare("SELECT deleted_at FROM data_items WHERE id='legal-doc'").get()).toEqual({ deleted_at: '2026-11-03T00:00:00.000Z' })
  })
})

describe('links', () => {
  it('stay inside the source Space even for someone in both', async () => {
    const auth = await member('both')
    await expect(changeDataReference(env, auth, { source: { type: 'item', id: 'sales-doc' }, target: { type: 'item', id: 'legal-doc' } })).rejects.toMatchObject({ statusCode: 404 })
    expect(db.prepare('SELECT COUNT(*) AS n FROM data_references').get()).toEqual({ n: 0 })
  })

  it('are refused for a target outside the boundary', async () => {
    await expect(changeDataReference(env, await member('sam'), { source: { type: 'item', id: 'sales-doc' }, target: { type: 'item', id: 'legal-item' } })).rejects.toThrow()
  })

  it('work inside one Space, and a stored link across Spaces never shows', async () => {
    const auth = await member('both')
    await changeDataReference(env, auth, { source: { type: 'item', id: 'sales-doc' }, target: { type: 'item', id: 'sales-item' } })
    db.exec(`INSERT INTO data_references(source_type,source_id,target_type,target_id,created_by) VALUES('item','sales-doc','item','legal-doc','owner')`)
    const links = await listDataReferences(env, auth, 'item', 'sales-doc')
    expect(links.outgoing.map(link => link.id)).toEqual(['sales-item'])
  })
})

describe('import', () => {
  it('cannot reach a database in another Space', async () => {
    await expect(bulkCreateRecords(env, await member('sam'), { databaseId: 'legal-db', preview: false, rows: [{ requestId: 'r1', title: 'X', values: {} }] })).rejects.toThrow()
    expect(db.prepare("SELECT COUNT(*) AS n FROM data_items WHERE database_id='legal-db'").get()).toEqual({ n: 1 })
  })
})

describe('names', () => {
  it('allows repeated page titles while keeping database names unique in a Space', () => {
    expect(() => db.exec(`INSERT INTO data_items(id,space_id,title,content,created_by) VALUES('again','${LEGAL}','plan SALES','','owner')`)).not.toThrow()
    expect(() => db.exec(`INSERT INTO data_items(id,space_id,title,content,created_by) VALUES('dup','${SALES}','plan SALES','','owner')`)).not.toThrow()
    expect(() => db.exec(`INSERT INTO database_definitions(id,space_id,name,created_by) VALUES('dup-db','${SALES}','PLAN deals','owner')`)).toThrow(/UNIQUE/)
  })
})
