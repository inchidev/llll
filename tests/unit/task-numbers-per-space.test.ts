import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { INIT_SQL } from '../../server/utils/db'
import { taskIdFromReference } from '../../server/utils/task-policy'
import type { AuthorizationContext } from '../../server/utils/authorization'
import { DEFAULT_SPACE_ID } from '../../shared/spaces'
import type { L4Env } from '../../workers/env'
import { d1 } from '../helpers/sqlite-d1'

const SALES = '00000000-0000-4000-8000-0000000000a1'

let db: DatabaseSync
const addTasks = (...ids: Array<[string, string]>) => {
  for (const [id, board] of ids) db.prepare("INSERT INTO tasks(id,board_id,title,created_by,created_at,updated_at) VALUES(?,?,?,'x','x','x')").run(id, board, id)
}
const numberOf = (id: string) => (db.prepare('SELECT number FROM task_numbers WHERE task_id=?').get(id) as { number: number }).number
const viewer = (active: string, ...reachable: string[]) => ({ spaces: { active, ids: reachable } }) as unknown as AuthorizationContext

beforeEach(() => {
  db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys=OFF')
  db.exec(INIT_SQL)
  db.exec(`INSERT INTO spaces(id,name) VALUES('${SALES}','Sales');
    INSERT INTO task_boards(id,space_id,name,created_by,created_at,updated_at) VALUES('general','${DEFAULT_SPACE_ID}','General','x','x','x'),('sales','${SALES}','Sales','x','x','x');`)
})

describe('Task numbers in each Space', () => {
  it('starts a Space with no Tasks at 1, and another Space does not move it', () => {
    addTasks(['a', 'general'], ['b', 'general'], ['c', 'sales'])
    expect([numberOf('a'), numberOf('b'), numberOf('c')]).toEqual([1, 2, 1])
    expect(db.prepare("SELECT space_id AS spaceId FROM task_numbers WHERE task_id='c'").get()).toMatchObject({ spaceId: SALES })
  })

  it('keeps a number unique within its Space', () => {
    addTasks(['a', 'general'], ['b', 'general'])
    expect(() => db.exec("UPDATE task_numbers SET number = 1 WHERE task_id = 'b'")).toThrow(/UNIQUE/u)
  })

  it('reads a number in the Space the viewer works in, and never in one they cannot reach', async () => {
    addTasks(['a', 'general'], ['c', 'sales'])
    const env = { DB: d1(db) } as unknown as L4Env
    expect(await taskIdFromReference(env, 1, viewer(SALES, DEFAULT_SPACE_ID, SALES))).toBe('c')
    expect(await taskIdFromReference(env, 1, viewer(DEFAULT_SPACE_ID, DEFAULT_SPACE_ID, SALES))).toBe('a')
    expect(await taskIdFromReference(env, 1, viewer(DEFAULT_SPACE_ID, DEFAULT_SPACE_ID))).toBe('a')
    expect(await taskIdFromReference(env, 2, viewer(DEFAULT_SPACE_ID, DEFAULT_SPACE_ID, SALES))).toBeNull()
    expect(await taskIdFromReference(env, 1)).toBeNull()
  })
})
