import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { searchDmMembers } from '../../server/utils/dm-search'

let sqlite: DatabaseSync
let db: D1Database

function d1(database: DatabaseSync): D1Database {
  return {
    prepare(sql: string) {
      let values: unknown[] = []
      const statement = {
        bind(...next: unknown[]) {
          values = next
          return statement
        },
        async all<T>() {
          return { results: database.prepare(sql).all(...values) as T[] }
        },
      }
      return statement
    },
  } as unknown as D1Database
}

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      handle TEXT,
      display_name TEXT NOT NULL,
      avatar_r2_key TEXT,
      status TEXT NOT NULL,
      nickname TEXT
    );
    CREATE TABLE auth_users (id TEXT PRIMARY KEY);

    INSERT INTO users VALUES
      ('viewer', 'human', 'viewer', 'Viewer', NULL, 'active', NULL),
      ('human', 'human', 'ada', 'Ada', NULL, 'active', NULL),
      ('agent', 'agent', NULL, 'Mike', NULL, 'active', NULL),
      ('removed', 'agent', NULL, 'Removed Agent', NULL, 'removed', NULL);
    INSERT INTO auth_users VALUES ('viewer'), ('human');
  `)
  db = d1(sqlite)
})

afterEach(() => sqlite.close())

describe('DM member search', () => {
  it('includes active agents even though they have no login identity', async () => {
    const members = await searchDmMembers(db, 'viewer', '')

    expect(members.map(member => member.displayName)).toEqual(['Ada', 'Mike'])
  })

  it('finds an agent by display name', async () => {
    const members = await searchDmMembers(db, 'viewer', 'mike')

    expect(members).toMatchObject([{ id: 'agent', kind: 'agent', displayName: 'Mike' }])
  })

  it('can hide agents from chat-only members', async () => {
    const members = await searchDmMembers(db, 'viewer', '', false)

    expect(members.map(member => member.displayName)).toEqual(['Ada'])
  })
})
