import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { INIT_SQL } from '../../server/utils/db'
import { loadAuthorizationContext } from '../../server/utils/authorization'
import { createTask, getTask, listTasks, updateTask } from '../../server/utils/task-service'
import { ALL_PERMISSIONS, Permission } from '../../shared/permissions'
import { DEFAULT_SPACE_ID } from '../../shared/spaces'
import { taskDescendants } from '../../shared/task-hierarchy'
import type { L4Env } from '../../workers/env'
import { d1 } from '../helpers/sqlite-d1'

const SERVER = '00000000-0000-4000-8000-000000000001'
const OTHER_SPACE = '00000000-0000-4000-8000-000000000002'
const NOW = '2026-11-04T00:00:00.000Z'
let db: DatabaseSync, env: L4Env
const auth = (principalId = 'owner') => loadAuthorizationContext(env, { principalId, credential: { kind: 'session', id: 's' } }).then(a => a!)
const input = (extra: Record<string, unknown> = {}) => ({ title: 'Work', description: '', priority: 'normal' as const, dueAt: null, assigneeId: null, channelId: null, labelIds: [], dependencyIds: [], ...extra })
const schedule = (promise: Promise<unknown>) => { void promise }
const insert = (id: string, parent: string | null = null, board = 'board', project: string | null = null) => db.prepare('INSERT INTO tasks(id,board_id,project_id,parent_task_id,title,created_by,created_at,updated_at) VALUES(?,?,?,?,?,\'owner\',?,?)').run(id, board, project, parent, id, NOW, NOW)
const patch = async (id: string, changes: Parameters<typeof updateTask>[3]) => updateTask(env, await auth(), id, changes, schedule)
beforeEach(() => {
  vi.stubGlobal('createError', (value: { statusMessage: string }) => Object.assign(new Error(value.statusMessage), value))
  db = new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys=ON'); db.exec(INIT_SQL)
  db.exec(`INSERT INTO roles(id,key,name,permissions_bitmask,resource_access_json,is_system,mentionable) VALUES
    ('owner-role','owner','Owner',${ALL_PERMISSIONS},'{}',1,0),('reader-role','custom:reader','Reader',${Permission.readTasks},'{}',0,0);
    INSERT INTO users(id,kind,display_name,status,role_id,joined_at) VALUES
    ('owner','human','Owner','active','owner-role','${NOW}'),('reader','human','Reader','active','reader-role','${NOW}');
    INSERT INTO server_identity(singleton,id) VALUES(1,'${SERVER}');
    INSERT INTO server(id,name,owner_id) VALUES('${SERVER}','Fixture','owner');
    INSERT INTO spaces(id,name) VALUES('${OTHER_SPACE}','Elsewhere');
    INSERT INTO projects(id,space_id,name,created_by,created_at,updated_at) VALUES('project-a','${DEFAULT_SPACE_ID}','A','owner','${NOW}','${NOW}'),('project-b','${DEFAULT_SPACE_ID}','B','owner','${NOW}','${NOW}');
    INSERT INTO task_boards(id,space_id,name,created_by,created_at,updated_at) VALUES('board','${DEFAULT_SPACE_ID}','Tasks','owner','${NOW}','${NOW}'),('other-board','${DEFAULT_SPACE_ID}','Other','owner','${NOW}','${NOW}'),('remote-board','${OTHER_SPACE}','Remote','owner','${NOW}','${NOW}');`)
  env = { DB: d1(db), SERVER_DO: { getByName: () => ({ notifyTasksChanged: async () => {} }) } } as unknown as L4Env
})
afterEach(() => { db.close(); vi.unstubAllGlobals() })

describe('ordinary Tasks with a hierarchy', () => {
  it('creates a child in the parent Project with its own priority, checklist, dependencies and status', async () => {
    insert('parent', null, 'board', 'project-a'); insert('dependency', null, 'board', 'project-a')
    const child = await createTask(env, await auth(), 'board', input({ parentTaskId: 'parent', priority: 'urgent', dependencyIds: ['dependency'] }), schedule)
    expect(child).toMatchObject({ parentTaskId: 'parent', projectId: 'project-a', priority: 'urgent', status: 'backlog', checklist: [], dependencyIds: ['dependency'], parent: { id: 'parent' } })
    expect((await getTask(env, await auth(), 'parent'))?.subtasks).toMatchObject([{ id: child.id }])
    await patch(child.id, { status: 'done' })
    expect(await getTask(env, await auth(), 'parent')).toMatchObject({ status: 'backlog', subtaskTotal: 1, subtaskCompleted: 1 })
  })
  it('links, reparents and detaches existing tasks without losing their data', async () => {
    insert('a'); insert('b'); insert('child')
    expect(await patch('child', { parentTaskId: 'a' })).toMatchObject({ parentTaskId: 'a' })
    expect(await patch('child', { parentTaskId: 'b' })).toMatchObject({ parentTaskId: 'b' })
    expect(await patch('child', { parentTaskId: null })).toMatchObject({ parentTaskId: null, parent: null, title: 'child' })
  })
  it('rejects self-parenting and long cycles in both the service and the database', async () => {
    insert('a'); insert('b', 'a'); insert('c', 'b')
    for (const parentTaskId of ['a', 'b', 'c']) {
      await expect(patch('a', { parentTaskId })).rejects.toMatchObject({ statusCode: 400 })
      expect(() => db.prepare('UPDATE tasks SET parent_task_id=? WHERE id=?').run(parentTaskId, 'a')).toThrow(/task_hierarchy_cycle/)
    }
  })
  it('serializes competing opposite links at the database boundary', () => {
    insert('a'); insert('b')
    // Both requests can validate against the unlinked state; the second committed write must fail.
    db.exec("UPDATE tasks SET parent_task_id='b' WHERE id='a'")
    expect(() => db.exec("UPDATE tasks SET parent_task_id='a' WHERE id='b'")).toThrow(/task_hierarchy_cycle/)
  })
  it.each([['other-board', null], ['remote-board', null], ['board', 'project-a']])('rejects a parent across boundary %s/%s', async (board, project) => {
    insert('parent', null, board!, project); insert('child')
    await expect(patch('child', { parentTaskId: 'parent' })).rejects.toBeTruthy()
    expect(() => db.exec("UPDATE tasks SET parent_task_id='parent' WHERE id='child'")).toThrow(/task_hierarchy_boundary/)
  })
  it('rejects both child and parent moves, including archived children, until detached', async () => {
    insert('parent'); insert('child', 'parent'); await patch('child', { archived: true })
    await expect(patch('parent', { boardId: 'other-board' })).rejects.toMatchObject({ statusCode: 400 })
    await expect(patch('parent', { projectId: 'project-a' })).rejects.toMatchObject({ statusCode: 400 })
    await expect(patch('child', { boardId: 'other-board' })).rejects.toMatchObject({ statusCode: 400 })
    expect(() => db.exec("UPDATE tasks SET project_id='project-a' WHERE id='parent'")).toThrow(/task_hierarchy_children/)
    await patch('child', { archived: false }); await patch('child', { parentTaskId: null, boardId: 'other-board' })
    expect(await patch('parent', { projectId: 'project-a' })).toMatchObject({ projectId: 'project-a' })
  })
  it('preserves children on parent deletion, and still deletes a whole board', () => {
    insert('parent'); insert('child', 'parent'); insert('grandchild', 'child')
    db.exec("UPDATE tasks SET archived_at='y' WHERE id='child'; DELETE FROM tasks WHERE id='parent'")
    expect(db.prepare("SELECT parent_task_id FROM tasks WHERE id='child'").get()).toMatchObject({ parent_task_id: null })
    expect(db.prepare("SELECT parent_task_id FROM tasks WHERE id='grandchild'").get()).toMatchObject({ parent_task_id: 'child' })
    db.exec("DELETE FROM task_boards WHERE id='board'")
    expect(db.prepare('SELECT COUNT(*) AS n FROM tasks').get()).toMatchObject({ n: 0 })
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  })
  it('archives independently, preserves navigation, and counts only active direct children', async () => {
    insert('parent'); insert('child', 'parent'); insert('grandchild', 'child')
    await patch('child', { status: 'done' }); await patch('parent', { archived: true })
    expect(await getTask(env, await auth(), 'child')).toMatchObject({ archivedAt: null, parent: { id: 'parent', archivedAt: expect.any(String) } })
    await patch('child', { archived: true })
    expect(await getTask(env, await auth(), 'parent')).toMatchObject({ subtaskTotal: 0, subtasks: [{ id: 'child', archivedAt: expect.any(String) }] })
    await patch('parent', { archived: false }); await patch('child', { archived: false })
    expect(await getTask(env, await auth(), 'parent')).toMatchObject({ subtaskTotal: 1, subtaskCompleted: 1 })
    const parent = (await listTasks(env, await auth())).flatMap(b => b.tasks).find(t => t.id === 'parent')
    expect(parent).toMatchObject({ subtaskTotal: 1, subtaskCompleted: 1 })
  })
  it('requires restoration before attaching to an archived parent or reparenting an archived child', async () => {
    insert('parent'); insert('child'); await patch('parent', { archived: true })
    await expect(patch('child', { parentTaskId: 'parent' })).rejects.toMatchObject({ statusCode: 400 })
    expect(() => insert('new-child', 'parent')).toThrow(/task_hierarchy_archived/)
    await patch('parent', { archived: false }); await patch('child', { archived: true })
    await expect(patch('child', { parentTaskId: 'parent' })).rejects.toMatchObject({ statusCode: 400 })
  })
  it('does not let read-only callers create, attach or detach tasks', async () => {
    insert('parent'); insert('child', 'parent')
    const reader = await auth('reader')
    expect((await getTask(env, reader, 'child'))?.parent?.id).toBe('parent')
    await expect(createTask(env, reader, 'board', input({ parentTaskId: 'parent' }), schedule)).rejects.toMatchObject({ statusCode: 403 })
    await expect(updateTask(env, reader, 'child', { parentTaskId: null }, schedule)).rejects.toMatchObject({ statusCode: 403 })
  })
  it('exposes no parent, descendant or count from a Project the caller cannot read', async () => {
    insert('secret-parent', null, 'board', 'project-a'); insert('secret-child', 'secret-parent', 'board', 'project-a'); insert('public')
    const reader = await auth('reader')
    expect((await listTasks(env, reader)).flatMap(b => b.tasks)).toMatchObject([{ id: 'public', parentTaskId: null, subtaskTotal: 0 }])
    await expect(getTask(env, reader, 'secret-child')).rejects.toMatchObject({ statusCode: 403 })
  })
  it('rejects an edge inserted across Projects as well as updated across them', () => {
    insert('parent', null, 'board', 'project-a')
    expect(() => insert('child', 'parent', 'board', 'project-b')).toThrow(/task_hierarchy_boundary/)
    expect(() => insert('child', 'missing')).toThrow(/task_hierarchy_boundary/)
  })
})
it('finds all descendants iteratively without hanging on malformed cycles', () => {
  expect([...taskDescendants([{ id: 'a', parentTaskId: 'c' }, { id: 'b', parentTaskId: 'a' }, { id: 'c', parentTaskId: 'b' }, { id: 'd' }], 'a')]).toEqual(['a', 'b', 'c'])
})
