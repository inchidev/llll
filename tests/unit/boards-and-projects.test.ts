import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { INIT_SQL } from '../../server/utils/db'
import { loadAuthorizationContext } from '../../server/utils/authorization'
import { addProjectRepository, createProject, ensureFirstBoard, listProjects } from '../../server/utils/project-service'
import { createTask, getTask, listTasks, updateTask } from '../../server/utils/task-service'
import { ALL_PERMISSIONS, Permission } from '../../shared/permissions'
import { DEFAULT_SPACE_ID } from '../../shared/spaces'
import type { L4Env } from '../../workers/env'
import { d1 } from '../helpers/sqlite-d1'

const SERVER = '00000000-0000-4000-8000-000000000001'
const NOW = '2026-11-01T00:00:00.000Z'
const noop = () => {}

let db: DatabaseSync
const rows = <T>(sql: string, ...values: Array<string | number>) => db.prepare(sql).all(...values) as T[]
const columns = (table: string) => rows<{ name: string }>(`PRAGMA table_info(${table})`).map(column => column.name)

beforeEach(() => {
  vi.stubGlobal('createError', (input: { statusCode: number; statusMessage: string; data: unknown }) => Object.assign(new Error(input.statusMessage), input))
  db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys=ON')
  db.exec(INIT_SQL)
})
afterEach(() => { db.close(); vi.unstubAllGlobals() })

describe('a fresh database', () => {
  it('migrates with no Owner yet, and the Server makes the first board when provisioned', async () => {
    expect(rows('SELECT id FROM projects')).toEqual([])
    db.exec(`INSERT INTO roles(id,key,name,permissions_bitmask,resource_access_json,is_system,mentionable) VALUES('owner-role','owner','Owner',${ALL_PERMISSIONS},'{}',1,0);
      INSERT INTO users(id,kind,display_name,status,role_id,joined_at) VALUES('olga','human','Olga','active','owner-role','${NOW}');`)
    const env = { DB: d1(db) } as unknown as L4Env
    await ensureFirstBoard(env, DEFAULT_SPACE_ID, 'olga')
    await ensureFirstBoard(env, DEFAULT_SPACE_ID, 'olga')
    expect(rows('SELECT name, space_id AS spaceId FROM task_boards')).toEqual([{ name: 'Tasks', spaceId: DEFAULT_SPACE_ID }])
  })

  it('has no Project on a board and no default Project', () => {
    expect(columns('task_boards')).not.toContain('project_id')
    expect(columns('projects')).not.toContain('is_default')
    expect(columns('tasks')).toContain('project_id')
  })
})

describe('boards in a Space, and a Project for repositories', () => {
  let env: L4Env
  const owner = () => loadAuthorizationContext(env, { principalId: 'olga', credential: { kind: 'session', id: 's' } }).then(auth => auth!)
  const input = (extra: Record<string, unknown> = {}) => ({ title: 'New', description: '', priority: 'normal' as const, dueAt: null, assigneeId: null, channelId: null, labelIds: [], dependencyIds: [], ...extra })
  const task = (id: string, boardId: string, projectId: string | null) =>
    db.prepare("INSERT INTO tasks(id,board_id,project_id,title,created_by,created_at,updated_at) VALUES(?,?,?,?,'olga',?,?)").run(id, boardId, projectId, `Title ${id}`, NOW, NOW)

  beforeEach(() => {
    db.exec(`INSERT INTO roles(id,key,name,permissions_bitmask,resource_access_json,is_system,mentionable) VALUES
        ('owner-role','owner','Owner',${ALL_PERMISSIONS},'{}',1,0),
        ('tasks-role','custom:tasks','Tasks',${Permission.readTasks},'{}',0,0);
      INSERT INTO users(id,kind,display_name,status,role_id,joined_at) VALUES('olga','human','Olga','active','owner-role','${NOW}'),('tess','human','Tess','active','tasks-role','${NOW}');
      INSERT INTO server_identity(singleton,id) VALUES(1,'${SERVER}');
      INSERT INTO server(id,name,owner_id) VALUES('${SERVER}','Fixture','olga');
      INSERT INTO projects(id,space_id,name,created_by,created_at,updated_at) VALUES
        ('alpha','${DEFAULT_SPACE_ID}','Alpha','olga','${NOW}','${NOW}'),('beta','${DEFAULT_SPACE_ID}','Beta','olga','${NOW}','${NOW}');
      INSERT INTO task_boards(id,space_id,name,position,created_by,created_at,updated_at) VALUES
        ('only-alpha','${DEFAULT_SPACE_ID}','Only Alpha',10,'olga','${NOW}','${NOW}'),
        ('only-none','${DEFAULT_SPACE_ID}','Only None',20,'olga','${NOW}','${NOW}');`)
    task('oa-1', 'only-alpha', 'alpha')
    task('on-1', 'only-none', null)
    env = { DB: d1(db), SERVER_DO: { getByName: () => ({ notifyTasksChanged: async () => {} }) } } as unknown as L4Env
  })

  it('lets a Task name a Project on any board, or none', async () => {
    const auth = await owner()
    expect((await createTask(env, auth, 'only-none', input(), noop)).projectId).toBeNull()
    expect((await createTask(env, auth, 'only-none', input({ projectId: 'beta' }), noop)).projectId).toBe('beta')
    await expect(createTask(env, auth, 'only-none', input({ projectId: 'missing-project' }), noop)).rejects.toMatchObject({ statusCode: 404 })
  })

  it('keeps a Task’s Project when it moves to another board, and changes it only when asked', async () => {
    const auth = await owner()
    expect((await updateTask(env, auth, 'oa-1', { boardId: 'only-none' }, noop)).projectId).toBe('alpha')
    expect((await updateTask(env, auth, 'oa-1', { projectId: 'beta' }, noop)).projectId).toBe('beta')
    expect((await updateTask(env, auth, 'oa-1', { projectId: null }, noop)).projectId).toBeNull()
  })

  it('starts a new Project with no board', async () => {
    const before = rows('SELECT id FROM task_boards')
    await createProject(env, await owner(), { name: 'Gamma' })
    expect(rows('SELECT id FROM task_boards')).toEqual(before)
  })

  it('allows access and repositories on any Project', async () => {
    const auth = await owner()
    await expect(addProjectRepository(env, auth, 'alpha', { provider: 'github', host: 'https://github.com', slug: 'a/b', defaultBranch: 'main' })).resolves.toBeTruthy()
    expect((await listProjects(env, auth)).map(project => project.id)).toContain('alpha')
  })

  it('lets a Role with Tasks read Tasks with no Project, and not a Project’s', async () => {
    const tess = (await loadAuthorizationContext(env, { principalId: 'tess', credential: { kind: 'session', id: 's' } }))!
    expect((await getTask(env, tess, 'on-1'))?.id).toBe('on-1')
    const seen = (await listTasks(env, tess)).flatMap(board => board.tasks.map(item => item.id))
    expect(seen).toContain('on-1')
    expect(seen).not.toContain('oa-1')
  })

  it('leaves the Project out of a board', async () => {
    for (const board of await listTasks(env, await owner())) expect(board).not.toHaveProperty('projectId')
  })
})
