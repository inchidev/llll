import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createError } from 'h3'
import { INIT_SQL } from '../../server/utils/db'
import { d1 } from '../helpers/sqlite-d1'
import { createItem, getItem, listItems, moveItem, updateItem } from '../../server/utils/item-service'
import { readRecords, updateRecord } from '../../server/utils/record-service'
import { changeDataTrash } from '../../server/utils/data-trash'
import { changeDataReference, listDataReferences } from '../../server/utils/data-references'
import { searchData } from '../../server/utils/data-search'
import { requireCanvas } from '../../server/utils/data-resources'
import { ALL_PERMISSIONS } from '../../shared/permissions'
import { DEFAULT_SPACE_ID } from '../../shared/spaces'
import type { AuthorizationContext } from '../../shared/authorization'
import type { L4Env } from '../../workers/env'
let db: DatabaseSync, env: L4Env
const auth: AuthorizationContext = {
  serverId: '00000000-0000-4000-8000-000000000001',
  principal: {
    id: 'owner',
    kind: 'human',
    roleId: 'owner',
    roleName: 'Owner',
    permissions: ALL_PERMISSIONS,
    isOwner: true,
  },
  credential: { kind: 'session' },
}
const seed = `INSERT INTO roles(id,key,name,permissions_bitmask) VALUES('owner','owner','Owner',${ALL_PERMISSIONS});
INSERT INTO users(id,display_name,status,role_id,joined_at) VALUES('owner','Owner','active','owner','2026-11-04');
INSERT INTO server_identity(singleton,id) VALUES(1,'${auth.serverId}');
INSERT INTO server(id,name,owner_id) VALUES('${auth.serverId}','Test','owner');
INSERT INTO database_definitions(id,name,created_by) VALUES('a','A','owner'),('b','B','owner');
INSERT INTO database_fields(id,database_id,name,type,slot,config_json,created_by) VALUES('text','a','Text','text','text_1','{}','owner'),('rel','a','Related','relation','links_1','{"relation":{"databaseId":"a"}}','owner');`
beforeEach(() => {
  vi.stubGlobal('createError', createError)
  db = new DatabaseSync(':memory:')
  db.exec(INIT_SQL)
  db.exec(seed)
  env = { DB: d1(db) } as L4Env
})
afterEach(() => {
  db.close()
  vi.unstubAllGlobals()
})
it('keeps identity, body, history, children and ordinary links when moving into and out of databases', async () => {
  const page = await createItem(env, auth, { title: 'Plan', content: '<p>Keep me</p>', icon: '📄' })
  const child = await createItem(env, auth, { parentId: page.id, title: 'Inside' })
  const target = await createItem(env, auth, { title: 'Target' })
  await changeDataReference(env, auth, {
    source: { type: 'item', id: page.id },
    target: { type: 'item', id: target.id },
  })
  await updateItem(env, auth, page.id, { version: 1, content: '<p>Updated body</p>' })
  const joined = await moveItem(env, auth, page.id, { version: 2, databaseId: 'a' })
  expect(joined).toMatchObject({
    id: page.id,
    content: '<p>Updated body</p>',
    databaseId: 'a',
    children: [{ id: child.id }],
  })
  await updateRecord(env, auth, page.id, { version: 3, values: { text: 'Value' } })
  await expect(moveItem(env, auth, page.id, { version: 4, databaseId: 'b' })).rejects.toMatchObject({ statusCode: 409 })
  const moved = await moveItem(env, auth, page.id, { version: 4, databaseId: 'b', discardProperties: true })
  expect(moved.content).toBe('<p>Updated body</p>')
  expect(db.prepare('SELECT text_1 FROM data_items WHERE id=?').get(page.id)?.text_1).toBeNull()
  expect((await listDataReferences(env, auth, 'item', page.id)).outgoing[0]?.id).toBe(target.id)
  expect(db.prepare('SELECT count(*) AS n FROM document_revisions WHERE document_id=?').get(page.id)?.n).toBe(1)
  const detached = await moveItem(env, auth, page.id, { version: 5, databaseId: null, discardProperties: true })
  expect(detached).toMatchObject({ databaseId: null, content: '<p>Updated body</p>', icon: '📄' })
})
it('clears incoming and outgoing property relations atomically and refuses stale moves', async () => {
  const one = await createItem(env, auth, { databaseId: 'a' }),
    two = await createItem(env, auth, { databaseId: 'a' })
  await updateRecord(env, auth, one.id, { version: 1, values: { rel: [two.id] } })
  await updateRecord(env, auth, two.id, { version: 1, values: { rel: [one.id] } })
  await expect(
    moveItem(env, auth, one.id, { version: 1, databaseId: 'b', discardProperties: true }),
  ).rejects.toMatchObject({ statusCode: 409 })
  expect(db.prepare('SELECT count(*) AS n FROM database_item_links').get()?.n).toBe(2)
  await moveItem(env, auth, one.id, { version: 2, databaseId: 'b', discardProperties: true })
  expect(db.prepare('SELECT count(*) AS n FROM database_item_links').get()?.n).toBe(0)
})
it('prevents cycles, cross-Space parent/database assignment and kind changes in storage', async () => {
  const root = await createItem(env, auth, {}),
    child = await createItem(env, auth, { parentId: root.id })
  await expect(moveItem(env, auth, root.id, { version: 1, parentId: child.id })).rejects.toMatchObject({
    statusCode: 400,
  })
  expect(() => db.prepare('UPDATE data_items SET parent_id=? WHERE id=?').run(child.id, root.id)).toThrow(
    'item_parent_cycle',
  )
  db.exec(
    "INSERT INTO spaces(id,name,created_by) VALUES('other','Other','owner'); INSERT INTO database_definitions(id,space_id,name,created_by) VALUES('foreign','other','Foreign','owner')",
  )
  await expect(moveItem(env, auth, root.id, { version: 1, databaseId: 'foreign' })).rejects.toMatchObject({
    statusCode: 404,
  })
  expect(() => db.prepare("UPDATE data_items SET kind='canvas' WHERE id=?").run(root.id)).toThrow(
    'item_identity_immutable',
  )
  expect(() =>
    db
      .prepare("INSERT INTO data_items(id,space_id,parent_id,title,created_by) VALUES('bad','other',?,'Bad','owner')")
      .run(root.id),
  ).toThrow('item_parent_scope')
})
it('filters inaccessible ancestors before list counts, search, direct reads and backlinks', async () => {
  const parent = await createItem(env, auth, { title: 'Secret' }),
    child = await createItem(env, auth, { title: 'Needle', parentId: parent.id, databaseId: 'a' })
  const unrelated = await createItem(env, auth, { title: 'Needle public' })
  const limited: AuthorizationContext = {
    ...auth,
    principal: { ...auth.principal, isOwner: false, resourceAccess: { documents: [unrelated.id], databases: ['a'] } },
  }
  await expect(getItem(env, limited, child.id)).rejects.toMatchObject({ statusCode: 403 })
  expect((await listItems(env, limited)).map((item) => item.id)).toEqual([unrelated.id])
  expect((await readRecords(env, limited, 'a')).total).toBe(0)
  expect((await searchData(env, limited, 'Needle')).map((item) => item.id)).toEqual([unrelated.id])
  const denied = { ...limited, principal: { ...limited.principal, resourceAccess: { documents: [], databases: [] } } }
  expect(await listItems(env, denied)).toEqual([])
})
it('hides a trashed subtree, restores it intact and purges children before their parent', async () => {
  const root = await createItem(env, auth, {}),
    child = await createItem(env, auth, { parentId: root.id, databaseId: 'a' }),
    other = await createItem(env, auth, { title: 'Visible' })
  await changeDataTrash(env, auth, 'item', root.id, 'trash')
  await expect(getItem(env, auth, child.id)).rejects.toMatchObject({ statusCode: 404 })
  expect((await listItems(env, auth)).map((item) => item.id)).toEqual([other.id])
  expect((await readRecords(env, auth, 'a')).total).toBe(0)
  await changeDataTrash(env, auth, 'item', root.id, 'restore')
  expect((await getItem(env, auth, child.id)).parentId).toBe(root.id)
  await changeDataTrash(env, auth, 'item', root.id, 'trash')
  await changeDataTrash(env, auth, 'item', root.id, 'purge')
  expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  expect((await listItems(env, auth)).map((item) => item.id)).toEqual([other.id])
})
it('canvas nodes retain their Item owner when it joins a database', async () => {
  const canvas = await createItem(env, auth, { kind: 'canvas' })
  db.prepare("INSERT INTO canvas_nodes(id,canvas_id,content,created_by) VALUES('node',?,'Sticky','owner')").run(
    canvas.id,
  )
  await moveItem(env, auth, canvas.id, { version: 1, databaseId: 'a' })
  expect((await requireCanvas(env, canvas.id, auth)).id).toBe(canvas.id)
  const page = await createItem(env, auth, {})
  expect(() =>
    db.prepare("INSERT INTO canvas_nodes(id,canvas_id,created_by) VALUES('bad',?,'owner')").run(page.id),
  ).toThrow('canvas_item_required')
})
it('migrates a populated published baseline without dangling foreign keys or changed IDs', () => {
  const old = new DatabaseSync(':memory:')
  old.exec('PRAGMA foreign_keys=ON')
  old.exec(readFileSync(new URL('../../drizzle/server-migrations/0000_baseline.sql', import.meta.url), 'utf8'))
  old.exec(seed)
  old.exec(`INSERT INTO documents(id,title,content,created_by) VALUES('doc','Brief','<p>Old</p>','owner');
 UPDATE documents SET content='<p>New</p>',version=2 WHERE id='doc';
 INSERT INTO canvases(id,title,created_by) VALUES('canvas','Canvas','owner');
 INSERT INTO canvas_nodes(id,canvas_id,created_by) VALUES('node','canvas','owner');
 INSERT INTO database_items(id,database_id,title,created_by) VALUES('record','a','Record','owner');
 INSERT INTO data_references(source_type,source_id,target_type,target_id,created_by) VALUES('document','doc','record','record','owner');
 INSERT INTO data_bookmarks(user_id,target_type,target_id) VALUES('owner','document','doc');`)
  old.exec(readFileSync(new URL('../../drizzle/server-migrations/0001_data_items.sql', import.meta.url), 'utf8'))
  expect(old.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  expect(old.prepare('SELECT id,kind,space_id FROM data_items ORDER BY id').all()).toEqual([
    { id: 'canvas', kind: 'canvas', space_id: DEFAULT_SPACE_ID },
    { id: 'doc', kind: 'page', space_id: DEFAULT_SPACE_ID },
    { id: 'record', kind: 'page', space_id: DEFAULT_SPACE_ID },
  ])
  expect(old.prepare('SELECT content FROM document_revisions WHERE document_id=?').get('doc')?.content).toBe(
    '<p>Old</p>',
  )
  expect(old.prepare('SELECT source_type,target_type FROM data_references').get()).toEqual({
    source_type: 'item',
    target_type: 'item',
  })
  expect(old.prepare('SELECT target_type FROM data_bookmarks').get()?.target_type).toBe('item')
  old.close()
})
