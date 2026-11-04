import { DatabaseSync } from 'node:sqlite'
import { beforeEach, afterEach, expect, it } from 'vitest'
import { INIT_SQL } from '../../server/utils/db'
import { d1 } from '../helpers/sqlite-d1'
import { ALL_PERMISSIONS, Permission } from '../../shared/permissions'
import type { AuthorizationContext } from '../../shared/authorization'
import type { L4Env } from '../../workers/env'
import { changeDataTrash, listDataTrash } from '../../server/utils/data-trash'
import { createItem, getItem, updateItem } from '../../server/utils/item-service'
import { listDocumentRevisions, restoreDocumentRevision } from '../../server/utils/document-revisions'
import { createRecord, readRecords } from '../../server/utils/record-service'
import { databaseFieldsFor, loadDatabaseItem } from '../../server/utils/database-data'
import { listAuthorizedTables } from '../../server/utils/table-catalog'
import { sanitizeDocumentHtml } from '../../server/utils/document-content'

let db: DatabaseSync, env: L4Env
const auth: AuthorizationContext = { serverId: '00000000-0000-4000-8000-000000000001', principal: { id: 'owner', kind: 'human', roleId: 'owner', roleName: 'Owner', permissions: ALL_PERMISSIONS, isOwner: true }, credential: { kind: 'session' } }
beforeEach(() => {
  db = new DatabaseSync(':memory:'); db.exec(INIT_SQL)
  db.exec(`INSERT INTO roles(id,key,name,permissions_bitmask) VALUES('owner','owner','Owner',${ALL_PERMISSIONS});
    INSERT INTO users(id,display_name,status,role_id,joined_at) VALUES('owner','Owner','active','owner','2026-11-03');
    INSERT INTO server_identity(singleton,id) VALUES(1,'${auth.serverId}');
    INSERT INTO server(id,name,owner_id) VALUES('${auth.serverId}','Test','owner');
    INSERT INTO database_definitions(id,name,created_by) VALUES('db','Records','owner');
    INSERT INTO database_fields(id,database_id,name,type,slot,created_by) VALUES('field','db','Text','text','text_1','owner');`)
  env = { DB: d1(db) } as L4Env
})
afterEach(() => db.close())

it('hides trashed records, restores their values, and retains field slots until purge', async () => {
  const item = await createRecord(env, auth, 'db', { title: 'Keep', values: { field: 'precious' } })
  await changeDataTrash(env, auth, 'item', item.id, 'trash')
  expect((await readRecords(env, auth, 'db')).total).toBe(0)
  expect(await loadDatabaseItem(env, item.id)).toBeNull()
  await changeDataTrash(env, auth, 'item', item.id, 'restore')
  expect((await readRecords(env, auth, 'db')).items[0]?.values.field).toBe('precious')
  await changeDataTrash(env, auth, 'field', 'field', 'trash')
  expect(await databaseFieldsFor(env, 'db')).toEqual([])
  expect(db.prepare('SELECT text_1 FROM data_items WHERE id=?').get(item.id)?.text_1).toBe('precious')
  await changeDataTrash(env, auth, 'field', 'field', 'restore')
  expect((await readRecords(env, auth, 'db')).items[0]?.values.field).toBe('precious')
  await changeDataTrash(env, auth, 'field', 'field', 'trash')
  await changeDataTrash(env, auth, 'field', 'field', 'purge')
  expect(db.prepare('SELECT text_1 FROM data_items WHERE id=?').get(item.id)?.text_1).toBeNull()
})

it('hides a trashed Database and its children even through direct IDs', async () => {
  const item = await createRecord(env, auth, 'db', { title: 'Child' })
  await changeDataTrash(env, auth, 'database', 'db', 'trash')
  expect(await listAuthorizedTables(env, auth)).toEqual([])
  await expect(readRecords(env, auth, 'db')).rejects.toMatchObject({ statusCode: 404 })
  expect(await loadDatabaseItem(env,item.id)).toBeNull()
  await changeDataTrash(env, auth, 'database', 'db', 'restore')
  expect((await readRecords(env, auth, 'db')).total).toBe(1)
})

it('requires manager permission, current resource access and a human session to purge', async () => {
  const document = await createItem(env, auth, { title: 'Private' })
  await changeDataTrash(env, auth, 'item', document.id, 'trash')
  const restricted: AuthorizationContext = { ...auth, principal: { ...auth.principal, isOwner: false, resourceAccess: { documents: [] } } }
  expect(await listDataTrash(env, restricted)).toEqual([])
  await expect(changeDataTrash(env, restricted, 'item', document.id, 'restore')).rejects.toThrow()
  const writer: AuthorizationContext = { ...auth, principal: { ...auth.principal, isOwner: false, permissions: Permission.readData | Permission.writeData } }
  await expect(changeDataTrash(env, writer, 'item', document.id, 'restore')).rejects.toThrow()
  await expect(changeDataTrash(env, { ...auth, principal: { ...auth.principal, kind: 'agent' } }, 'item', document.id, 'purge')).rejects.toMatchObject({ statusCode: 403 })
  await changeDataTrash(env, auth, 'item', document.id, 'restore')
  expect((await getItem(env, auth, document.id)).title).toBe('Private')
})

it('stores safe HTML and restores an earlier revision as a new version', async () => {
  const document = await createItem(env, auth, { title: 'Draft', content: '<p onclick="bad()">One<script>bad()</script></p>' })
  expect(document.content).toBe('<p>One</p>')
  await updateItem(env, auth, document.id, { content: '<p>Two</p>', version: 1 })
  expect(await listDocumentRevisions(env, auth, document.id)).toMatchObject([{ version: 1, title: 'Draft' }])
  await expect(restoreDocumentRevision(env, auth, document.id, 1, 1)).rejects.toMatchObject({ statusCode: 409 })
  const restored = await restoreDocumentRevision(env, auth, document.id, 1, 2)
  expect(restored).toMatchObject({ version: 3, content: '<p>One</p>' })
  expect((await listDocumentRevisions(env, auth, document.id)).map(revision => revision.version)).toEqual([2, 1])
})

it('retains only 50 previous changed document versions', async () => {
  const doc = await createItem(env, auth, { title: 'History' })
  for (let version = 1; version <= 55; version++) await updateItem(env, auth, doc.id, { version, content: `<p>${version}</p>` })
  const revisions = await listDocumentRevisions(env, auth, doc.id)
  expect(revisions).toHaveLength(50)
  expect(revisions.at(-1)?.version).toBe(6)
})

it.each(['<a href="jav&#x61;script:alert(1)">bad</a>', '<svg><a onload="bad()">x</a></svg>', '<iframe srcdoc="<script>bad()</script>"></iframe>', '<img src=x onerror=bad()>', '<a href="//evil.example">bad</a>'])('removes executable HTML: %s', input => {
  const html = sanitizeDocumentHtml(input)
  expect(html).not.toMatch(/javascript:|onerror|onload|<svg|<iframe|<img|srcdoc|href="\/\//u)
  expect(sanitizeDocumentHtml(html)).toBe(html)
})

it('does not clear a field when a concurrent restore wins before purge', async () => {
  await createRecord(env, auth, 'db', { title: 'Keep', values: { field: 'precious' } })
  await changeDataTrash(env, auth, 'field', 'field', 'trash')
  const batch = env.DB.batch.bind(env.DB)
  env.DB.batch = async statements => {
    db.exec("UPDATE database_fields SET deleted_at=NULL WHERE id='field'")
    return batch(statements)
  }
  await changeDataTrash(env, auth, 'field', 'field', 'purge')
  expect(db.prepare('SELECT text_1 FROM data_items').get()?.text_1).toBe('precious')
  expect(db.prepare("SELECT id FROM database_fields WHERE id='field'").get()).toBeTruthy()
})

it.each(['trash-parent', 'reuse-slot'] as const)('rejects record creation if %s happens between validation and commit', async change => {
  const batch = env.DB.batch.bind(env.DB)
  env.DB.batch = async statements => {
    if (change === 'trash-parent') db.exec("UPDATE database_definitions SET deleted_at='now' WHERE id='db'")
    else db.exec("DELETE FROM database_fields WHERE id='field'; INSERT INTO database_fields(id,database_id,name,type,slot,created_by) VALUES('replacement','db','Replacement','text','text_1','owner')")
    return batch(statements)
  }
  await expect(createRecord(env, auth, 'db', { requestId: 'stable', title: 'Stale create', values: { field: 'wrong field' } })).rejects.toMatchObject({ statusCode: 409 })
  expect(db.prepare('SELECT COUNT(*) AS n FROM data_items').get()?.n).toBe(0)
  expect(db.prepare('SELECT COUNT(*) AS n FROM data_record_requests').get()?.n).toBe(0)
})
