import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { d1ExecSql, INIT_SQL } from '../../server/utils/db'
import { LEGACY_SQL } from '../fixtures/legacy-migrations/init'
import { validateTaskAssignee } from '../../server/utils/task-policy'
import taskPeopleAndDiscussionsSql from '../fixtures/legacy-migrations/0027_task_people_and_discussions.sql?raw'

beforeAll(() => vi.stubGlobal('createError', (input: { statusCode: number; statusMessage: string; data: unknown }) => Object.assign(new Error(input.statusMessage), input)))
afterAll(() => vi.unstubAllGlobals())

/** Enough of D1 for Drizzle: prepared statements with first/all/run/raw. */
function d1(sqlite: DatabaseSync): D1Database {
  function prepare(sql: string) {
    let values: SQLInputValue[] = []
    const statement = {
      sql,
      bind(...next: SQLInputValue[]) { values = next; return statement },
      async first<T>() { return sqlite.prepare(sql).get(...values) as T | null },
      async all<T>() { return { results: sqlite.prepare(sql).all(...values) as T[] } },
      async raw() { return sqlite.prepare(sql).all(...values).map(row => Object.values(row as object)) },
      async run() { return { success: true, meta: sqlite.prepare(sql).run(...values) } },
    }
    return statement
  }
  return { prepare } as unknown as D1Database
}

const now = '2026-09-28T00:00:00.000Z'

function seed(sqlite: DatabaseSync) {
  sqlite.exec(`
    INSERT INTO identity_keys (id, name, email, email_verified, created_at, updated_at) VALUES
      ('human', 'Ada', 'ada@example.test', 1, 0, 0),
      ('removed', 'Gone', 'gone@example.test', 1, 0, 0),
      ('agent', 'Helper', 'helper@example.test', 1, 0, 0),
      ('paused', 'Sleepy', 'sleepy@example.test', 1, 0, 0);
    INSERT INTO roles (id, key, name, permissions_bitmask, position, is_system, created_at, updated_at) VALUES
      ('member-role', 'member', 'member', 112, 2, 1, '${now}', '${now}');
    INSERT INTO users (id, kind, display_name, status, role_id, joined_at, created_at, updated_at) VALUES
      ('human', 'human', 'Ada', 'active', 'member-role', '${now}', '${now}', '${now}'),
      ('removed', 'human', 'Gone', 'removed', NULL, NULL, '${now}', '${now}'),
      ('agent', 'agent', 'Helper', 'active', 'member-role', '${now}', '${now}', '${now}'),
      ('paused', 'agent', 'Sleepy', 'active', 'member-role', '${now}', '${now}', '${now}');
  `)
  const agentColumns = (sqlite.prepare('PRAGMA table_info(agents)').all() as Array<{ name: string, notnull: number, dflt_value: unknown }>)
  const required = agentColumns.filter(column => column.notnull && column.dflt_value === null).map(column => column.name)
  for (const [userId, status] of [['agent', 'active'], ['paused', 'paused']] as const) {
    const row: Record<string, SQLInputValue> = {}
    for (const name of required) row[name] = name === 'user_id' ? userId : name === 'status' ? status : name.endsWith('_at') ? now : name === 'created_by' ? 'human' : `${name}-${userId}`
    row.user_id = userId
    row.status = status
    const names = Object.keys(row)
    sqlite.prepare(`INSERT INTO agents (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`).run(...Object.values(row))
  }
}

describe('task assignees', () => {
  let sqlite: DatabaseSync

  beforeEach(() => {
    sqlite = new DatabaseSync(':memory:')
    sqlite.exec(INIT_SQL)
    seed(sqlite)
  })

  it('accepts active people and active agents', async () => {
    const env = { DB: d1(sqlite) } as never
    await expect(validateTaskAssignee(env, 'human')).resolves.toBeUndefined()
    await expect(validateTaskAssignee(env, 'agent')).resolves.toBeUndefined()
    await expect(validateTaskAssignee(env, null)).resolves.toBeUndefined()
  })

  it('rejects removed members and paused agents', async () => {
    const env = { DB: d1(sqlite) } as never
    await expect(validateTaskAssignee(env, 'removed')).rejects.toThrow('Active member not found')
    await expect(validateTaskAssignee(env, 'paused')).rejects.toThrow('Active agent not found')
    await expect(validateTaskAssignee(env, 'missing')).rejects.toThrow('Active member not found')
  })
})

describe('migration 0027', () => {
  it('moves agent assignments to the member assignee column', () => {
    const migration = d1ExecSql(taskPeopleAndDiscussionsSql)
    expect(LEGACY_SQL).toContain(migration)
    const sqlite = new DatabaseSync(':memory:')
    sqlite.exec(LEGACY_SQL.replace(migration, ''))
    seed(sqlite)
    sqlite.exec(`
      INSERT INTO task_boards (id, name, created_by, created_at, updated_at) VALUES ('board', 'Board', 'human', '${now}', '${now}');
      INSERT INTO tasks (id, board_id, title, assignee_id, created_by, created_at, updated_at) VALUES
        ('assigned', 'board', 'Assigned to an agent', 'agent', 'human', '${now}', '${now}'),
        ('open', 'board', 'Unassigned', NULL, 'human', '${now}', '${now}');
    `)

    sqlite.exec(migration)

    expect(sqlite.prepare('SELECT id, assignee_id, assignee_user_id, discussion_channel_id FROM tasks ORDER BY id').all()).toEqual([
      { id: 'assigned', assignee_id: null, assignee_user_id: 'agent', discussion_channel_id: null },
      { id: 'open', assignee_id: null, assignee_user_id: null, discussion_channel_id: null },
    ])
    // People can now be assigned, which the agents-only column could not hold.
    expect(() => sqlite.exec(`UPDATE tasks SET assignee_user_id = 'human' WHERE id = 'open'`)).not.toThrow()
  })
})
