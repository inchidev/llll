import { DatabaseSync } from 'node:sqlite'
import { beforeEach, afterEach, expect, it } from 'vitest'
import { INIT_SQL } from '../../server/utils/db'
import { d1 } from '../helpers/sqlite-d1'
import { ALL_PERMISSIONS } from '../../shared/permissions'
import type { AuthorizationContext } from '../../shared/authorization'
import type { L4Env } from '../../workers/env'
import { bulkCreateRecords, exportDatabaseCsv } from '../../server/utils/data-transfer'
import { parseDataCsv, csvCell } from '../../shared/data-csv'
import { createItem } from '../../server/utils/item-service'
import { documentMarkdown } from '../../server/utils/document-content'
import { searchData } from '../../server/utils/data-search'
import { changeDataTrash } from '../../server/utils/data-trash'
import { changeDataReference, listDataReferences } from '../../server/utils/data-references'
import { loadDatabasePage } from '../../server/utils/database-views'
import { defaultDatabaseViewConfig } from '../../shared/database'

let db: DatabaseSync, env: L4Env
const auth: AuthorizationContext = { serverId: '00000000-0000-4000-8000-000000000001', principal: { id: 'owner', kind: 'human', roleId: 'owner', roleName: 'Owner', permissions: ALL_PERMISSIONS, isOwner: true }, credential: { kind: 'session' } }
beforeEach(() => {
  db = new DatabaseSync(':memory:'); db.exec(INIT_SQL)
  db.exec(`INSERT INTO roles(id,key,name,permissions_bitmask) VALUES('owner','owner','Owner',${ALL_PERMISSIONS});
    INSERT INTO users(id,display_name,status,role_id,joined_at) VALUES('owner','Owner','active','owner','2026-11-03');
    INSERT INTO server_identity(singleton,id) VALUES(1,'${auth.serverId}');
    INSERT INTO server(id,name,owner_id) VALUES('${auth.serverId}','Test','owner');
    INSERT INTO database_definitions(id,name,created_by) VALUES('db','Records','owner');
    INSERT INTO database_fields(id,database_id,name,type,slot,created_by) VALUES('score','db','Score','number','number_1','owner');`)
  env = { DB: d1(db) } as L4Env
})
afterEach(() => db.close())

it('parses quoted multiline CSV and escapes formulas without changing numeric negatives', () => {
  expect(parseDataCsv('\uFEFFTitle,Notes\r\n"A, B","one\ntwo ""quoted"""\r\n')).toEqual([['Title', 'Notes'], ['A, B', 'one\ntwo "quoted"']])
  expect(() => parseDataCsv('Title\n"Unclosed')).toThrow('unclosed')
  expect(() => parseDataCsv('Title,Notes\nOnly one')).toThrow('same number')
  expect(csvCell('=1+1')).toBe("'=1+1")
  expect(csvCell('=1+1', false)).toBe('=1+1')
  expect(csvCell(-2)).toBe('-2')
})

it('validates each row, previews without writes and retries successful imports once', async () => {
  const rows = [{ requestId: 'one', title: 'Good', values: { score: 5 } }, { requestId: 'two', title: 'Bad', values: { score: 'oops' } }, { requestId: 'three', title: '' }]
  const preview = await bulkCreateRecords(env, auth, { databaseId: 'db', rows })
  expect(preview.results.map(row => row.ok)).toEqual([true, false, false])
  expect(db.prepare('SELECT COUNT(*) AS n FROM data_items').get()?.n).toBe(0)
  const result = await bulkCreateRecords(env, auth, { databaseId: 'db', rows, preview: false })
  expect(result.results.map(row => row.ok)).toEqual([true, false, false])
  const retry = await bulkCreateRecords(env, auth, { databaseId: 'db', rows, preview: false })
  expect(retry.results[0]).toEqual(result.results[0])
  expect(db.prepare('SELECT COUNT(*) AS n FROM data_items').get()?.n).toBe(1)
  const conflicting = await bulkCreateRecords(env, auth, { databaseId: 'db', rows: [{ ...rows[0], title: 'Changed' }], preview: false })
  expect(conflicting.results[0]).toMatchObject({ ok: false, error: { code: 'request_conflict' } })
})

it('exports all matching records in view order, with only visible fields and safe titles', async () => {
  const rows = [{ requestId: 'a', title: '=Formula', values: { score: 2 } }, { requestId: 'b', title: 'First', values: { score: 1 } }, { requestId: 'c', title: 'Excluded', values: { score: 0 } }]
  await bulkCreateRecords(env, auth, { databaseId: 'db', rows, preview: false })
  db.prepare('UPDATE database_views SET config_json=? WHERE database_id=?').run(JSON.stringify({ ...defaultDatabaseViewConfig(), visibleFieldIds: [], filters: [{ fieldId: 'score', operator: 'greater_than', value: 0 }], sorts: [{ fieldId: 'score', direction: 'asc' }] }), 'db')
  expect(await exportDatabaseCsv(env, auth, 'db', {})).toBe("Title\r\nFirst\r\n'=Formula\r\n")
  const restricted = { ...auth, principal: { ...auth.principal, isOwner: false, resourceAccess: { databases: [] } } }
  await expect(exportDatabaseCsv(env, restricted, 'db', {})).rejects.toThrow()
})

it('imports Markdown safely and searches body content only within current access', async () => {
  const doc = await createItem(env, auth, { title: 'Brief', format: 'markdown', content: '# Research\n\nA **rare finding**.\n<script>evil()</script>' })
  expect(doc.content).toContain('<h1>Research</h1>')
  expect(doc.content).not.toContain('evil')
  expect(await documentMarkdown(doc.content)).toContain('**rare finding**')
  expect(await searchData(env, auth, 'rare finding')).toMatchObject([{ id: doc.id, type: 'item' }])
  const hidden = { ...auth, principal: { ...auth.principal, isOwner: false, resourceAccess: { documents: [] } } }
  expect(await searchData(env, hidden, 'rare finding')).toEqual([])
  await changeDataTrash(env, auth, 'item', doc.id, 'trash')
  expect(await searchData(env, auth, 'rare finding')).toEqual([])
})

it('hides backlinks after access is revoked or a document is trashed and recovers them on restore', async () => {
  const a = await createItem(env, auth, { title: 'Private source' })
  const b = await createItem(env, auth, { title: 'Public target' })
  await changeDataReference(env, auth, { source: { type: 'item', id: a.id }, target: { type: 'item', id: b.id } })
  expect((await listDataReferences(env, auth, 'item', b.id)).incoming).toMatchObject([{ id: a.id }])
  const limited = { ...auth, principal: { ...auth.principal, isOwner: false, resourceAccess: { documents: [b.id] } } }
  expect((await listDataReferences(env, limited, 'item', b.id)).incoming).toEqual([])
  await expect(changeDataReference(env, limited, { source: { type: 'item', id: b.id }, target: { type: 'item', id: a.id } })).rejects.toThrow()
  await changeDataTrash(env, auth, 'item', a.id, 'trash')
  expect((await listDataReferences(env, auth, 'item', b.id)).incoming).toEqual([])
  await changeDataTrash(env, auth, 'item', a.id, 'restore')
  expect((await listDataReferences(env, auth, 'item', b.id)).incoming).toHaveLength(1)
  await changeDataTrash(env, auth, 'item', a.id, 'trash')
  await changeDataTrash(env, auth, 'item', a.id, 'purge')
  expect(db.prepare('SELECT COUNT(*) AS n FROM data_references').get()?.n).toBe(0)
})

it.each(['board', 'calendar'] as const)('loads each %s group beyond the first global 100 independently', async layout => {
  db.exec(`INSERT INTO database_fields(id,database_id,name,type,slot,config_json,created_by) VALUES
    ('status','db','Status','select','select_1','{"options":["A","B"]}','owner'),
    ('date','db','Date','date','date_1','{}','owner');`)
  const config = { ...defaultDatabaseViewConfig(), sorts: [], groupFieldId: 'status', dateFieldId: 'date' }
  db.prepare('UPDATE database_views SET layout=?,config_json=? WHERE database_id=?').run(layout, JSON.stringify(config), 'db')
  const insert = db.prepare('INSERT INTO data_items(id,database_id,title,select_1,date_1,position,created_by) VALUES(?,?,?,?,?,?,?)')
  for (let index = 0; index < 125; index++) insert.run(`a${index}`, 'db', `A ${index}`, 'A', '2026-11-03', index, 'owner')
  for (let index = 0; index < 15; index++) insert.run(`b${index}`, 'db', `B ${index}`, 'B', '2026-11-04', 200 + index, 'owner')
  const range = layout === 'calendar' ? { dateFrom: '2026-11-01', dateTo: '2026-11-30' } : {}
  if (layout === 'calendar') await expect(loadDatabasePage(env, 'db', { page: 1, pageSize: 100, groupPages: {} })).rejects.toMatchObject({ statusCode: 400 })
  const first = await loadDatabasePage(env, 'db', { ...range, page: 1, pageSize: 100, groupPages: {} })
  expect(first.items).toHaveLength(20)
  expect(first.items.some(item => item.id === 'b0')).toBe(true)
  const key = layout === 'board' ? 'A' : '2026-11-03'
  const next = await loadDatabasePage(env, 'db', { ...range, page: 1, pageSize: 100, groupPages: { [key]: 13 } })
  expect(next.items.map(item => item.id)).toContain('a124')
  expect(next.items.map(item => item.id)).toContain('b0')
  expect(next.groupCounts?.[key]).toBe(125)
  if (layout === 'calendar') {
    const exported = parseDataCsv(await exportDatabaseCsv(env, auth, 'db', { dateFrom: '2026-11-04', dateTo: '2026-11-04' }))
    expect(exported).toHaveLength(16)
    expect(exported[1]?.[0]).toBe('B 0')
  }
})
